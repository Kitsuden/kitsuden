/**
 * Streaming operations (`output.flow` on the server): Server-Sent Events read
 * as an `AsyncIterable` of typed events.
 *
 *   for await (const step of api.imports.progress({ id })) {
 *     console.log(step.done, "/", step.total);
 *   }
 *
 * Standard SSE (`text/event-stream`), no custom protocol: every `data:` event
 * is one item (JSON), `event: end` closes the stream, `event: error` carries a
 * problem+json and throws `KitsudenApiError`. Breaking out of the loop aborts
 * the request, and the server closes its generator.
 *
 * Not retried: a stream may have done work by the time it fails. Zero
 * dependencies, like the rest of the client: `fetch` + `ReadableStream`.
 */

import { KitsudenApiError, KitsudenNetworkError } from "./errors";
import { buildUrl, metaOf, problemOf, type RawRequest, type TransportConfig } from "./transport";
import type { Problem } from "./types";

interface RawEvent {
  event?: string;
  data: string;
}

function parseBlock(block: string): RawEvent | null {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length === 0 && !event) return null;
  return { event, data: data.join("\n") };
}

function json(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export async function* streamEvents<E>(
  cfg: TransportConfig,
  req: RawRequest
): AsyncGenerator<E, void, undefined> {
  const { info, params } = req;
  const o = req.options ?? {};
  const url = buildUrl(cfg.baseUrl, info, params);
  const headers: Record<string, string> = { ...cfg.headers, accept: "text/event-stream" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (cfg.sessionCookie) headers.cookie = cfg.sessionCookie;
  let body: BodyInit | undefined;
  if (req.body !== undefined && info.body !== null) {
    if (info.body === "multipart") body = req.body as BodyInit;
    else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }
  }
  Object.assign(headers, o.headers ?? {});

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await cfg.fetch(url, {
      method: info.method,
      headers,
      body,
      signal: ctl.signal,
      ...(cfg.credentials ? { credentials: cfg.credentials } : {}),
    });
  } catch (err) {
    o.signal?.removeEventListener("abort", onAbort);
    if (o.signal?.aborted) throw err;
    throw new KitsudenNetworkError(
      `${info.method} ${url}: ${(err as Error)?.message ?? String(err)}`,
      {
        cause: err,
        operation: info,
        attempts: 1,
        timedOut: false,
      }
    );
  }

  const meta = metaOf(res, info, null, 1);
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (res.status !== 200 || !type.includes("text/event-stream") || !res.body) {
    // Not a stream: an error (or anything else) answered before it started.
    o.signal?.removeEventListener("abort", onAbort);
    const t = await res.text();
    const p = json(t);
    const problem =
      p && typeof p === "object" && "code" in (p as object)
        ? (p as Problem)
        : problemOf(res.status, p, res.statusText);
    throw new KitsudenApiError(problem, meta, null);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) rest += decoder.decode(value, { stream: true });
      if (done) rest += decoder.decode();
      const blocks = rest.split(/\r?\n\r?\n/);
      rest = done ? "" : (blocks.pop() ?? "");
      for (const b of blocks) {
        const ev = parseBlock(b);
        if (!ev) continue;
        if (ev.event === "end") {
          finished = true;
          return;
        }
        if (ev.event === "error") {
          finished = true;
          const p = json(ev.data);
          const problem =
            p && typeof p === "object" && "code" in (p as object)
              ? (p as Problem)
              : problemOf(500, p, "Stream error");
          throw new KitsudenApiError(problem, meta, null);
        }
        if (!ev.event || ev.event === "message") yield json(ev.data) as E;
      }
      if (done) {
        finished = true;
        return;
      }
    }
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    if (!finished) {
      // The caller stopped iterating: close the connection (the server
      // cancels its generator and runs its `finally`).
      ctl.abort();
      await reader.cancel().catch(() => {});
    }
  }
}
