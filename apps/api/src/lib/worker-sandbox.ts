/**
 * Kitsuden — Sandbox for user code (`code` actions and functions)
 * ============================================================================
 *
 * ── HISTORY ────────────────────────────────────────────────────────────────
 *
 *   · Until 2026-10-25: a same-process `Worker` with `process`/`require`
 *     covered by local variables. `globalThis.process.env` held all the
 *     secrets and `import("node:child_process")` executed commands.
 *   · 2026-10-25: Bun child process with an empty environment. Better, but the
 *     code was still host JavaScript: it read files (`apps/api/.env`
 *     included), opened connections anywhere, launched processes and, on
 *     Linux, could read `/proc/<API pid>/environ`.
 *
 * ── WHAT THERE IS NOW (2026-10-26) ─────────────────────────────────────────
 *
 * Two layers, each sufficient on its own for what it promises:
 *
 *   1. LANGUAGE: the code runs inside QuickJS compiled to WebAssembly
 *      (`quickjs-emscripten`). There, `process`, `require`, `import`,
 *      `fetch`, `Bun`, files and network do not exist: it is not that they are
 *      covered, it is that the interpreter does not have them. The only thing the code can do besides
 *      computing is ASK the parent, by text, for three things:
 *        · `fetch(url)`        only to allowlisted hosts;
 *        · `kitsuden.api.*`    the Kitsuden API, as the identity that the
 *                              action engine assigns it (see
 *                              `lib/sandbox/identity.ts`): same permissions,
 *                              same RLS, same quotas and approvals as that
 *                              identity over the network. Without an identity, no API.
 *        · `kitsuden.effect()` the at-most-once ledger of external effects
 *                              (`kitsuden_action_effects`, the same as
 *                              `ctx.effect` in TypeScript actions), with keys
 *                              scoped to the action. See "Effects" below.
 *   2. PROCESS: the interpreter lives in a child process with an EMPTY environment
 *      (the API's secrets do not exist there), with `node --permission` if there is
 *      Node >= 22 (read-only access to the QuickJS packages; no writing, no
 *      processes, no threads, no addons) and killed on timeout. A loop, an
 *      `OOM` or an interpreter crash do not touch the API.
 *
 * Limits: interpreter memory (`memoryLimitMb`), stack, time (inside
 * QuickJS by interrupt, and outside with `kill`), number of host calls,
 * size of logs, of result and of each response.
 *
 * It remains OFF by default in production (`ENABLE_CODE_ACTIONS=true` to
 * turn it on): owner's decision, see docs/agents/sandbox.md.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { messageOf, type EffectStore } from "@kitsuden/engine";

import { egressProblem, type CustomerDataGuard } from "./customer-data";
import { inProduction } from "./environment";
import { pinnedFetch, resolveTarget, UnsafeTargetError } from "./safe-fetch";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Response that the internal API returns to the code (all text). */
export interface SandboxResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: string;
  url?: string;
}

/**
 * The Kitsuden API injected into the code. It is set by the action
 * engine with the identity of whoever executes; only the shape is validated here.
 */
export type SandboxApi = (method: string, path: string, body: unknown) => Promise<SandboxResponse>;

export interface SandboxInput {
  /** User's JS code (as a string) */
  code: string;
  /** Data payload passed to the function as `event` */
  payload: Record<string, unknown>;
  /** Variables available as `env` (there is no `process.env`) */
  envVars: Record<string, string>;
  /** Max execution time in ms */
  timeoutMs: number;
  /** Max memory of the interpreter in MB */
  memoryLimitMb: number;
  /** Hosts that `fetch` may call, in addition to KITSUDEN_SANDBOX_FETCH_ALLOW. */
  fetchAllow?: string[];
  /** Kitsuden API with the identity of whoever executes (without it, no API). */
  api?: SandboxApi | null;
  /** Maximum host calls (fetch + api) per execution. */
  maxCalls?: number;
  /**
   * Customer data (lib/customer-data.ts): what this execution read of marked
   * fields, and the hosts that may receive it. `fetch` to any other host whose
   * request carries one of those values is refused. Without it, no check.
   */
  customerData?: CustomerDataGuard;
  /**
   * The TEST of a draft (lib/promotion.ts). It runs even if
   * `ENABLE_CODE_ACTIONS` is off because nothing leaves here: `fetch` is
   * answered by this function (never the network) and `api` is the simulated one passed
   * by the caller. See docs/agents/promotion.md.
   */
  probe?: { fetch: (request: MockFetchRequest) => Promise<SandboxResponse> };
  /**
   * The store behind `kitsuden.effect(key, fn)`. Without it (and outside a
   * test), the code's effect calls fail saying so. In a test (`probe`) an
   * in-memory store answers: nothing is written.
   */
  effects?: SandboxEffects | null;
}

/** Where `kitsuden.effect()` records what it did (see "Effects" below). */
export interface SandboxEffects {
  /** Keys belong to this scope: `action:<id>` for a panel-defined code action. */
  scope: string;
  /** Recorded with each effect (`job_id`): the execution that ran it. */
  runId: string | null;
  store: EffectStore;
}

/** What the code asked `fetch` for during a test (already validated). */
export interface MockFetchRequest {
  url: string;
  method: string;
  body?: string;
}

export interface SandboxResult {
  success: boolean;
  /** Return value from the user's function (if any) */
  result: unknown;
  /** Captured console.log/warn/error output */
  logs: string;
  /** Error message (if failed) */
  error: string | null;
  /** Execution duration in ms */
  durationMs: number;
  /** Memory used by the interpreter */
  memoryUsedBytes: number;
  /** How the execution ended */
  exitReason: "success" | "error" | "timeout" | "killed";
}

/** Can code actions be executed? (see the header) */
export function enabledCodeActions(): boolean {
  const value = process.env.ENABLE_CODE_ACTIONS;
  if (value === "true") return true;
  if (value === "false") return false;
  return !inProduction();
}

// ═══════════════════════════════════════════════════════════════
// Limits
// ═══════════════════════════════════════════════════════════════

const LIMITS = {
  /** The most an action can ask for, even if its configuration says more. */
  maxTimeMs: 60_000,
  maxMemoryMb: 256,
  defaultCalls: 50,
  maxCalls: 500,
  /** Child output (stdout), fetch/api response, logs, result. */
  maxOutput: 4_000_000,
  maxResponse: 1_000_000,
  maxLogs: 50_000,
  maxResult: 1_000_000,
  fetchTimeoutMs: 10_000,
  /** `kitsuden.effect()` calls per execution (they do not count toward `maxCalls`). */
  maxEffects: 100,
  /** The largest JSON result an effect may record. */
  maxEffectResult: 64 * 1024,
} as const;

/** API paths that the code CANNOT call (recursion and sessions). */
const BANNED_PATHS = [
  /^\/api\/actions(\/|$|\?)/,
  /^\/api\/functions(\/|$|\?)/,
  /^\/api\/auth(\/|$|\?)/,
];

// ═══════════════════════════════════════════════════════════════
// The child process
// ═══════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where `child.mjs` is. From source, next to this file; from the
 * `dist/` bundle (production image), in `src/` (which the image copies),
 * relative to the API's cwd.
 */
function childRoute(): string {
  const candidates = [
    process.env.KITSUDEN_SANDBOX_CHILD,
    join(HERE, "sandbox", "child.mjs"),
    join(HERE, "..", "src", "lib", "sandbox", "child.mjs"),
    join(process.cwd(), "src", "lib", "sandbox", "child.mjs"),
    join(process.cwd(), "apps", "api", "src", "lib", "sandbox", "child.mjs"),
  ].filter((c): c is string => !!c);
  const route = candidates.find((c) => existsSync(c));
  if (!route) throw new Error("Sandbox child script (child.mjs) not found");
  return realpathSync(route);
}

/** Root of a package (the folder with its package.json) from one of its files. */
function packageRoot(file: string): string {
  let d = dirname(file);
  while (!existsSync(join(d, "package.json")) && dirname(d) !== d) d = dirname(d);
  return d;
}

interface Startup {
  executable: string;
  args: string[];
  /** true if the process runs with Node's permission model. */
  permissions: boolean;
}

let cachedStartup: Startup | null = null;

/** Is there a Node >= 22 with `--permission`? It is checked once. */
function nodeWithPermissions(): string | null {
  const chosenItem = process.env.KITSUDEN_SANDBOX_RUNTIME;
  if (chosenItem === "bun") return null;
  const binary = chosenItem && chosenItem !== "node" ? chosenItem : "node";
  try {
    const r = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const major = Number(/^v(\d+)/.exec(String(r.stdout).trim())?.[1] ?? 0);
    return major >= 22 ? binary : null;
  } catch {
    return null;
  }
}

/**
 * How to launch the child: the executable, its arguments (with the URLs of the
 * QuickJS modules) and, with Node, the list of the only things it can read.
 */
export function sandboxStartup(): Startup {
  if (cachedStartup) return cachedStartup;
  const child = childRoute();
  const req = createRequire(child);
  const from = (r: NodeRequire, p: string) => realpathSync(r.resolve(p));
  // `require.resolve` from the child's folder: the same node_modules as the API.
  const core = from(req, "quickjs-emscripten-core");
  const variant = from(req, "@jitl/quickjs-singlefile-mjs-release-sync");
  const coreRoot = packageRoot(core);
  const ffi = packageRoot(from(createRequire(core), "@jitl/quickjs-ffi-types"));
  // The core imports `@jitl/quickjs-ffi-types` by name: it must be possible to
  // read the node_modules where it lives (with pnpm, the package's own).
  const reads = [child, dirname(coreRoot), coreRoot, ffi, packageRoot(variant)];
  const modules = [pathToFileURL(core).href, pathToFileURL(variant).href];

  const node = nodeWithPermissions();
  cachedStartup = node
    ? {
        executable: node,
        args: [
          "--permission",
          ...[...new Set(reads)].map((r) => `--allow-fs-read=${r}`),
          "--max-old-space-size=128",
          child,
          ...modules,
        ],
        permissions: true,
      }
    : { executable: process.execPath, args: ["--smol", child, ...modules], permissions: false };
  return cachedStartup;
}

/** Tests only: forget the chosen startup. */
export function _forgetStartup(): void {
  cachedStartup = null;
}

/**
 * The child's environment: NOTHING from the API. On Windows the runtime needs
 * `SystemRoot` to start (it is not a secret: it is `C:\Windows`).
 */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  return env;
}

// ═══════════════════════════════════════════════════════════════
// The code's calls to the host
// ═══════════════════════════════════════════════════════════════

/** Allowed hosts: those of the action and those of the server (`a.com`, `*.a.com`). */
export function allowedHosts(ofTheAction: string[] = []): string[] {
  const ofTheServer = (process.env.KITSUDEN_SANDBOX_FETCH_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    ...new Set([...ofTheAction, ...ofTheServer].map((h) => h.trim().toLowerCase()).filter(Boolean)),
  ];
}

export function allowedHost(hostname: string, list: string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return list.some((p) =>
    p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p
  );
}

class CallError extends Error {}

async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new CallError(`Response too large (max ${max} bytes)`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function safeHeaders(h: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (!h || typeof h !== "object") return output;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (
      typeof v === "string" &&
      /^[A-Za-z0-9-]{1,64}$/.test(k) &&
      v.length < 8192 &&
      !/[\r\n]/.test(v)
    ) {
      output[k] = v;
    }
  }
  return output;
}

/**
 * The allow-list checks a NAME, and a name can resolve to anything: an allowed
 * host pointing at 169.254.169.254 or at a service of the Docker network would
 * hand its response to the code. `KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH=true` is
 * the opt-in for actions that really call an internal service.
 */
export async function requirePublicHost(hostname: string): Promise<void> {
  if (sandboxAllowsInternal()) return;
  try {
    await resolveTarget(hostname);
  } catch (err) {
    throw err instanceof UnsafeTargetError ? new CallError(err.message) : err;
  }
}

const sandboxAllowsInternal = () => process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH === "true";

/**
 * Customer data: refuses the request if it carries a value this execution read
 * from a marked field and the host is not allowed for customer data.
 */
function checkCustomerData(
  guard: CustomerDataGuard | undefined,
  url: URL,
  headers: Record<string, string>,
  body: string | undefined
): void {
  const problem = egressProblem(guard, { url: url.href, hostname: url.hostname, headers, body });
  if (!problem) return;
  guard?.onBlock?.({ channel: "sandbox_fetch", decision: "refused", ...problem.block });
  throw new CallError(problem.message);
}

async function callFetch(
  args: Record<string, unknown>,
  list: string[],
  guard?: CustomerDataGuard
): Promise<SandboxResponse> {
  let url: URL;
  try {
    url = new URL(String(args.url ?? ""));
  } catch {
    throw new CallError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CallError(`Protocol not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) throw new CallError("Credentials in URL are not allowed");
  if (!allowedHost(url.hostname, list)) {
    throw new CallError(
      `Host not allowed: ${url.hostname} (allowed: ${list.length ? list.join(", ") : "none"})`
    );
  }
  const method = String(args.method ?? "GET").toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) {
    throw new CallError(`Method not allowed: ${method}`);
  }
  // Resolved and checked ONCE, and the connection goes to those addresses: a
  // name that answers differently to the check and to the connection (DNS
  // rebinding) cannot reach an internal service (lib/safe-fetch.ts). Redirects
  // are returned as is: one to another host would bypass the allowlist.
  const headers = safeHeaders(args.headers);
  const body =
    typeof args.body === "string" && method !== "GET" && method !== "HEAD" ? args.body : undefined;
  checkCustomerData(guard, url, headers, body);
  let res: Response;
  try {
    res = await pinnedFetch(url, {
      method,
      headers,
      body,
      timeoutMs: LIMITS.fetchTimeoutMs,
      allowInternal: sandboxAllowsInternal(),
    });
  } catch (err) {
    throw err instanceof UnsafeTargetError ? new CallError(err.message) : err;
  }
  return {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: await readBounded(res, LIMITS.maxResponse),
    url: url.href,
  };
}

/** Validates an API path for the code: relative, under `/api/`, no tricks. */
export function validApiPath(path: string): string | null {
  if (typeof path !== "string" || path.length > 2048) return "Invalid path";
  if (!path.startsWith("/api/")) return "Path must start with /api/";
  if (/[\s\\#]/.test(path) || path.includes("..") || path.includes("//")) return "Invalid path";
  if (BANNED_PATHS.some((r) => r.test(path))) return `Path not available from the sandbox: ${path}`;
  // The checks above read the raw text; the router sees it after `new Request`
  // normalizes it (`%2e%2e`) and Hono decodes it (`%61ctions`). Same checks on that.
  const raw = path.split("?")[0]!;
  let normalized: string;
  let decoded: string;
  try {
    normalized = new URL(raw, "http://sandbox.invalid").pathname;
    decoded = decodeURIComponent(normalized);
  } catch {
    return "Invalid path";
  }
  // `.` and `..` segments written with escapes: `new Request` would remove them.
  if (decoded !== decodeURIComponent(raw)) return "Invalid path";
  if (/[\s\\#]/.test(decoded) || decoded.includes("..") || decoded.includes("//"))
    return "Invalid path";
  if (BANNED_PATHS.some((r) => r.test(decoded)))
    return `Path not available from the sandbox: ${path}`;
  return null;
}

async function callApi(args: Record<string, unknown>, api: SandboxApi | null | undefined) {
  if (!api) {
    throw new CallError(
      "This code has no Kitsuden API identity (declare `scopes` on the action; see docs/agents/sandbox.md)"
    );
  }
  const method = String(args.method ?? "GET").toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method))
    throw new CallError(`Method not allowed: ${method}`);
  const path = String(args.path ?? "");
  const reason = validApiPath(path);
  if (reason) throw new CallError(reason);
  const r = await api(method, path, args.body);
  if (r.body.length > LIMITS.maxResponse) throw new CallError("Response too large");
  return r;
}

// ═══════════════════════════════════════════════════════════════
// Effects: `kitsuden.effect(key, fn)` across the boundary
// ═══════════════════════════════════════════════════════════════
//
// A closure cannot leave QuickJS, so the prologue (child.mjs) splits the call:
//
//   1. host call `effect` {phase: "begin", key}  → the ledger answers:
//        done     → the stored result comes back and `fn` does NOT run;
//        run      → the code runs `fn` inside the sandbox;
//        busy     → another execution is running it now: the call throws;
//        unknown  → an earlier attempt was left unfinished: the call throws
//                   (unless the code passed `{ retryUnknown: true }`).
//   2. host call `effect` {phase: "finish", key, ok, result | error}.
//
// The host keeps which keys THIS execution began: a `finish` for any other
// key is refused, so code that talks to `__request` by hand cannot close an
// effect that another execution is running. A key begun and never finished
// (timeout, crash) stays `running` and later reads as `unknown`, which is the
// truth: nobody knows whether it happened.

export const EFFECT_KEY_MAX = 500;

/** In-memory ledger for a test (`probe`): the same answers, nothing written. */
export function memoryEffectStore(): EffectStore {
  const rows = new Map<
    string,
    { status: "running" | "done" | "failed"; result: unknown; attempts: number }
  >();
  return {
    async begin({ scope, key }) {
      const id = JSON.stringify([scope, key]);
      const row = rows.get(id);
      if (row?.status === "done") {
        return { decision: "done", result: row.result, attempts: row.attempts };
      }
      if (row?.status === "running") {
        return { decision: "busy", result: null, attempts: row.attempts };
      }
      const attempts = (row?.attempts ?? 0) + 1;
      rows.set(id, { status: "running", result: null, attempts });
      return { decision: "run", result: null, attempts };
    },
    async finish({ scope, key, ok, result }) {
      const id = JSON.stringify([scope, key]);
      const row = rows.get(id);
      if (!row || row.status !== "running") return;
      rows.set(id, {
        status: ok ? "done" : "failed",
        result: ok ? result : null,
        attempts: row.attempts,
      });
    },
  };
}

interface EffectState {
  effects: SandboxEffects | null;
  begun: Set<string>;
  calls: number;
}

/** One `effect` host call (begin or finish). Exported for the unit tests. */
export async function callEffect(
  args: Record<string, unknown>,
  state: EffectState
): Promise<unknown> {
  if (!state.effects) {
    throw new CallError(
      "kitsuden.effect() is not available here: effects are recorded per action, and this code runs outside one"
    );
  }
  const key = args.key;
  if (typeof key !== "string" || key.length === 0 || key.length > EFFECT_KEY_MAX) {
    throw new CallError(`The effect key must be a string of 1 to ${EFFECT_KEY_MAX} characters`);
  }
  const { scope, runId, store } = state.effects;

  if (args.phase === "begin") {
    state.calls++;
    if (state.calls > LIMITS.maxEffects) {
      throw new CallError(`Too many effects in one execution (max ${LIMITS.maxEffects})`);
    }
    if (state.begun.has(key)) {
      throw new CallError(`The effect "${key}" is already running in this execution`);
    }
    const stale =
      args.staleAfterMs === undefined || args.staleAfterMs === null
        ? 10 * 60_000
        : Number(args.staleAfterMs);
    if (!Number.isInteger(stale) || stale < 1000) {
      throw new CallError("`staleAfterMs` must be an integer of at least 1000");
    }
    const begun = await store.begin({
      scope,
      key,
      jobId: runId,
      staleAfterMs: stale,
      retryUnknown: args.retryUnknown === true,
    });
    if (begun.decision === "done") return { decision: "done", result: begun.result ?? null };
    if (begun.decision === "busy") {
      throw new CallError(
        `The effect "${key}" is running in another execution right now; run the action again later`
      );
    }
    if (begun.decision === "unknown") {
      throw new CallError(
        `The effect "${key}" was left unfinished by an earlier attempt, so it may or may not have ` +
          `happened. It is not run again on its own: check it, or pass { retryUnknown: true } if ` +
          `repeating it is harmless.`
      );
    }
    state.begun.add(key);
    return { decision: "run", attempts: begun.attempts };
  }

  if (args.phase === "finish") {
    if (!state.begun.delete(key)) {
      throw new CallError(`The effect "${key}" was not begun by this execution`);
    }
    const ok = args.ok === true;
    let result: unknown = ok ? (args.result ?? null) : null;
    if (ok && JSON.stringify(result).length > LIMITS.maxEffectResult) {
      // Recorded as done (it happened), without a result that would not fit.
      result = { truncated: true };
    }
    await store.finish({
      scope,
      key,
      ok,
      result,
      error: ok ? null : String(args.error ?? "error").slice(0, 2000),
    });
    return { ok: true };
  }

  throw new CallError("Unknown effect phase");
}

/** A fresh per-execution state (exported for the unit tests). */
export function effectState(effects: SandboxEffects | null): EffectState {
  return { effects, begun: new Set(), calls: 0 };
}

// ═══════════════════════════════════════════════════════════════
// Sandbox Executor
// ═══════════════════════════════════════════════════════════════

function failure(
  error: string,
  exitReason: SandboxResult["exitReason"],
  durationMs: number,
  logs = ""
): SandboxResult {
  return { success: false, result: null, logs, error, durationMs, memoryUsedBytes: 0, exitReason };
}

/** `fetch` in a test: the same shape checks, and the simulation responds. */
async function callMockFetch(
  args: Record<string, unknown>,
  test: NonNullable<SandboxInput["probe"]>,
  list: string[],
  guard?: CustomerDataGuard
): Promise<SandboxResponse> {
  let url: URL;
  try {
    url = new URL(String(args.url ?? ""));
  } catch {
    throw new CallError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CallError(`Protocol not allowed: ${url.protocol}`);
  }
  // The same allowlist as in production: the test must not pass something that is later rejected.
  if (!allowedHost(url.hostname, list)) {
    throw new CallError(
      `Host not allowed: ${url.hostname} (allowed: ${list.length ? list.join(", ") : "none"})`
    );
  }
  const method = String(args.method ?? "GET").toUpperCase();
  checkCustomerData(
    guard,
    url,
    safeHeaders(args.headers),
    typeof args.body === "string" ? args.body : undefined
  );
  const r = await test.fetch({
    url: url.href,
    method: method,
    body: typeof args.body === "string" ? args.body : undefined,
  });
  if (r.body.length > LIMITS.maxResponse) throw new CallError("Response too large");
  return r;
}

/**
 * Runs the code in the isolated interpreter (see the header).
 */
export async function executeSandbox(input: SandboxInput): Promise<SandboxResult> {
  // A test does not talk to the network or the real API: it always runs.
  if (!input.probe && !enabledCodeActions()) {
    return failure(
      "Code actions are disabled on this server (set ENABLE_CODE_ACTIONS=true to enable them).",
      "killed",
      0
    );
  }

  const timeMs = Math.min(Math.max(Number(input.timeoutMs) || 5000, 50), LIMITS.maxTimeMs);
  const memoryMb = Math.min(Math.max(Number(input.memoryLimitMb) || 64, 8), LIMITS.maxMemoryMb);
  const maxCalls = Math.min(
    Math.max(Number(input.maxCalls) || LIMITS.defaultCalls, 0),
    LIMITS.maxCalls
  );
  const list = allowedHosts(input.fetchAllow);
  const effects = effectState(
    input.effects ??
      (input.probe ? { scope: "probe", runId: null, store: memoryEffectStore() } : null)
  );

  const start = performance.now();
  const duration = () => Math.round(performance.now() - start);

  let startup: Startup;
  try {
    startup = sandboxStartup();
  } catch (err) {
    return failure(`Sandbox unavailable: ${messageOf(err)}`, "killed", 0);
  }

  return await new Promise<SandboxResult>((finish) => {
    let finished = false;
    let read = 0;
    let calls = 0;
    let stderr = "";
    let pending = "";

    const child = spawn(startup.executable, startup.args, {
      // Any folder: the child does not write to disk.
      cwd: dirname(startup.args[startup.args.length - 3] ?? process.cwd()),
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const close = (r: SandboxResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(clock);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already finished */
      }
      finish(r);
    };

    // Wall-clock time: process startup + the code + the calls.
    // The margin covers Node/Bun startup and loading the WASM.
    const clock = setTimeout(
      () => close(failure(`Function timed out after ${timeMs}ms`, "timeout", duration())),
      timeMs + 3000
    );

    const send = (m: unknown) => {
      if (!finished && child.stdin.writable) child.stdin.write(JSON.stringify(m) + "\n");
    };

    const handle = async (m: { id: number; op: string; args: Record<string, unknown> | null }) => {
      if (m.op === "effect") {
        // Counted on their own (LIMITS.maxEffects): wrapping a fetch in an
        // effect must not halve the calls the code has.
        try {
          const args = m.args && typeof m.args === "object" ? m.args : {};
          send({ t: "response", id: m.id, ok: true, value: await callEffect(args, effects) });
        } catch (err) {
          send({ t: "response", id: m.id, ok: false, error: messageOf(err) });
        }
        return;
      }
      calls++;
      if (calls > maxCalls) {
        send({
          t: "response",
          id: m.id,
          ok: false,
          error: `Too many host calls (max ${maxCalls})`,
        });
        return;
      }
      try {
        const args = m.args && typeof m.args === "object" ? m.args : {};
        const value =
          m.op === "fetch"
            ? input.probe
              ? await callMockFetch(args, input.probe, list, input.customerData)
              : await callFetch(args, list, input.customerData)
            : m.op === "api"
              ? await callApi(args, input.api)
              : (() => {
                  throw new CallError(`Unknown host call: ${m.op}`);
                })();
        // What the code READ through the API: its marked values are tracked.
        if (m.op === "api" && input.customerData) {
          input.customerData.marked.collectText(
            (value as SandboxResponse).body,
            String(args.path ?? "")
          );
        }
        send({ t: "response", id: m.id, ok: true, value: value });
      } catch (err) {
        send({ t: "response", id: m.id, ok: false, error: messageOf(err) });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      read += chunk.length;
      if (read > LIMITS.maxOutput) {
        close(failure("Sandbox output too large", "killed", duration()));
        return;
      }
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === "call") {
          void handle(m as never);
        } else if (m.t === "fin") {
          const error = typeof m.error === "string" && m.error ? m.error : null;
          const interrupted = !!error && /interrupted/i.test(error);
          close({
            success: !error,
            result: error ? null : (m.result ?? null),
            logs: typeof m.logs === "string" ? m.logs : "",
            error: interrupted ? `Function timed out after ${timeMs}ms (${error})` : error,
            durationMs: duration(),
            memoryUsedBytes: Number(m.memory) || 0,
            exitReason: error ? (interrupted ? "timeout" : "error") : "success",
          });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (t: string) => {
      if (stderr.length < 4000) stderr += t;
    });
    child.on("error", (err) =>
      close(failure(`Failed to run function: ${messageOf(err)}`, "killed", duration()))
    );
    child.on("close", () =>
      close(
        failure(
          `Function process ended without a result${stderr ? `: ${stderr.slice(0, 2000)}` : ""}`,
          "killed",
          duration()
        )
      )
    );
    child.stdin.on("error", () => {});

    send({
      t: "start",
      code: input.code,
      event: input.payload ?? {},
      env: input.envVars ?? {},
      limits: {
        memoryMb,
        timeMs,
        logsBytes: LIMITS.maxLogs,
        resultBytes: LIMITS.maxResult,
      },
    });
  });
}

/** For the startup report and the tests: what process isolation is in place. */
export function describeSandbox(): { runtime: string; permissions: boolean } {
  const a = sandboxStartup();
  return {
    runtime: a.executable === process.execPath ? "bun" : a.executable,
    permissions: a.permissions,
  };
}

/** Exported for tests: the same limits executeSandbox uses. */
export const _limits = LIMITS;
