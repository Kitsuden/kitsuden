/**
 * An outbound HTTP call that connects to the address it checked
 * ============================================================================
 *
 * The sandbox `fetch`, `webhook_out`, the OAuth client metadata (CIMD) and the
 * agent notifications resolved the target's name, refused it if any address
 * was internal, and then called `fetch(url)`, which RESOLVED AGAIN. A name with
 * a short TTL can answer a public address to the check and 169.254.169.254 (or
 * a container of the Docker network) to the connection: DNS rebinding
 * (security review 2026-11-03).
 *
 * `pinnedFetch` resolves once, checks every address, and connects only to
 * those: the request goes through `node:http`/`node:https` with a `lookup` that
 * returns the verified addresses and nothing else. The name is still the
 * request's host, so TLS sends it as SNI and validates the certificate against
 * it, and the `Host` header is the real one. It works the same under Bun and
 * Node (the global `fetch` of neither accepts a custom resolver: Bun ignores
 * undici dispatchers, and Node's has no public hook).
 *
 * Redirects are never followed (the callers return 3xx as is), like
 * `redirect: "manual"` before.
 */

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import { nonPublicAddress } from "./public-address";

export class UnsafeTargetError extends Error {
  readonly reason: "unresolvable" | "non_public";
  constructor(reason: "unresolvable" | "non_public", message: string) {
    super(message);
    this.name = "UnsafeTargetError";
    this.reason = reason;
  }
}

type Resolver = (host: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });
let resolver: Resolver = systemResolver;

/** Tests only: replaces DNS (to simulate a rebinding name). `null` restores it. */
export function setResolverForTests(r: Resolver | null): void {
  resolver = r ?? systemResolver;
}

/**
 * The addresses of `hostname`, all of them public unless `allowInternal`.
 * Throws `UnsafeTargetError` otherwise. An IP literal is its own address.
 */
export async function resolveTarget(
  hostname: string,
  options: { allowInternal?: boolean } = {}
): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  let addresses: LookupAddress[];
  if (family) {
    addresses = [{ address: host, family }];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new UnsafeTargetError("unresolvable", `Host could not be resolved: ${hostname}`);
    }
  }
  if (!addresses.length) {
    throw new UnsafeTargetError("unresolvable", `Host could not be resolved: ${hostname}`);
  }
  if (!options.allowInternal && addresses.some((a) => nonPublicAddress(a.address))) {
    throw new UnsafeTargetError("non_public", `Host resolves to a non-public address: ${hostname}`);
  }
  return addresses;
}

export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort after this many milliseconds, body included (default 30 s). */
  timeoutMs?: number;
  /** Opt-in for internal targets (each caller has its own variable). */
  allowInternal?: boolean;
}

/** `lookup` for node:net that only ever answers the verified addresses. */
function pinnedLookup(addresses: LookupAddress[]) {
  return (
    _hostname: string,
    options: unknown,
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void
  ) => {
    const opts = (typeof options === "object" && options ? options : {}) as {
      all?: boolean;
      family?: number;
    };
    const wanted = opts.family === 4 || opts.family === 6 ? opts.family : 0;
    const pool = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    const list = pool.length ? pool : addresses;
    if (opts.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  };
}

function headersOf(res: IncomingMessage): Headers {
  const h = new Headers();
  const raw = res.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      h.append(raw[i]!, raw[i + 1]!);
    } catch {
      // A header value the Fetch API refuses is dropped, not fatal
    }
  }
  return h;
}

/**
 * `fetch` for a target chosen by someone else: resolves and checks the host,
 * then connects only to the checked addresses. Returns a standard `Response`.
 */
export async function pinnedFetch(
  input: string | URL,
  init: PinnedFetchInit = {}
): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`Protocol not allowed: ${url.protocol}`);
  }
  const addresses = await resolveTarget(url.hostname, { allowInternal: init.allowInternal });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const secure = url.protocol === "https:";
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const body =
    init.body !== undefined && method !== "GET" && method !== "HEAD" ? init.body : undefined;
  if (
    body !== undefined &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")
  ) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  return new Promise<Response>((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        lookup: pinnedLookup(addresses) as never,
        // SNI and the certificate check use the NAME, not the pinned address
        ...(secure && !isIP(host) ? { servername: host } : {}),
        // A fresh connection per call: a pooled socket could belong to another resolution
        agent: false,
      },
      (res) => {
        // The timer keeps running while the body streams: a receiver that
        // trickles bytes is cut off like one that never answers.
        res.on("close", () => clearTimeout(timer));
        const status = res.statusCode ?? 502;
        const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        try {
          resolve(
            new Response(
              noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
              {
                status: status < 200 || status > 599 ? 502 : status,
                statusText: res.statusMessage ?? "",
                headers: headersOf(res),
              }
            )
          );
        } catch (err) {
          res.destroy();
          reject(err);
        }
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`The request timed out after ${init.timeoutMs} ms`));
    }, init.timeoutMs ?? 30_000);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
