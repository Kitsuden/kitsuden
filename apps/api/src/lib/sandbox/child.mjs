/**
 * Kitsuden — sandbox child process (QuickJS interpreter in WASM)
 * ============================================================================
 *
 * Launched by `worker-sandbox.ts` with an EMPTY environment and, if Node >= 22 is available, with
 * `--permission` (it can only read this file and the QuickJS packages; no
 * writing, no spawning processes, no threads, no addons). It talks to the parent over
 * stdin/stdout, one JSON line per message.
 *
 * The user's code does NOT run in this JavaScript process: it runs inside
 * QuickJS, an interpreter compiled to WebAssembly. In there there is no
 * `process`, no `require`, no module `import`, no `fetch`, no file system:
 * only the language and what this file injects (console, the event,
 * the declared variables and the functions that ASK the parent for things:
 * fetch, the Kitsuden API and the effects ledger). It is
 * isolation by construction, not by hiding names.
 *
 * Messages:
 *   parent → child  {t:"start", code, event, env, limits, capabilities}
 *                   {t:"response", id, ok, value | error}
 *   child → parent  {t:"call", id, op, args}
 *                   {t:"fin", result, logs, error, memory}
 *
 * This file is .mjs on purpose: Node or Bun runs it as is, without
 * compiling, and from the `dist/` bundle it still exists in `src/`.
 */

// The two QuickJS modules arrive as file:// URLs in argv (the parent resolves
// them): with `--permission` this process can only read those folders, so
// it cannot look for packages through node_modules as a normal import would.
const [coreUrl, variantUrl] = process.argv.slice(2);

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");

// ── Reading lines from stdin ───────────────────────────────────────────────
let pending = "";
const waitingStart = [];
const responses = new Map();
let start = null;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let i;
  while ((i = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.t === "start" && !start) {
      start = m;
      for (const f of waitingStart.splice(0)) f(m);
    } else if (m.t === "response") {
      const r = responses.get(m.id);
      if (r) {
        responses.delete(m.id);
        r(m);
      }
    }
  }
});
// If the parent goes away, this process has nothing to do.
process.stdin.on("end", () => process.exit(0));

const initialMessage = () =>
  start ? Promise.resolve(start) : new Promise((r) => waitingStart.push(r));

// ── Prologue that runs INSIDE QuickJS ──────────────────────────────────────
//
// Builds `kitsuden`, `fetch` and `console` on top of the host's three functions
// (`__request`, `__log`) and the input JSONs. Everything that crosses the boundary is
// TEXT: no host object reaches the user's code.
const PROLOGUE = `
"use strict";
const __createResponse = (r) => {
  const body = typeof r.body === "string" ? r.body : "";
  return Object.freeze({
    status: r.status, ok: r.status >= 200 && r.status < 300, statusText: r.statusText || "",
    headers: Object.freeze(Object.assign({}, r.headers || {})),
    url: r.url || "",
    async text() { return body; },
    async json() { return JSON.parse(body); },
  });
};
const __call = async (op, args) => {
  const r = JSON.parse(await __request(op, JSON.stringify(args)));
  if (!r.ok) throw new Error(r.error || "host call failed");
  return r.value;
};
const __text = (a) => {
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch (e) { return String(a); }
};
const console = Object.freeze({
  log: (...a) => __log("LOG", a.map(__text).join(" ")),
  info: (...a) => __log("LOG", a.map(__text).join(" ")),
  debug: (...a) => __log("LOG", a.map(__text).join(" ")),
  warn: (...a) => __log("WARN", a.map(__text).join(" ")),
  error: (...a) => __log("ERROR", a.map(__text).join(" ")),
});
globalThis.console = console;
const event = JSON.parse(__event);
const env = Object.freeze(JSON.parse(__env));
const fetch = async (url, options) => {
  const o = options || {};
  return __createResponse(await __call("fetch", {
    url: String(url), method: o.method, headers: o.headers,
    body: o.body === undefined || o.body === null ? undefined : String(o.body),
  }));
};
const __api = async (method, path, body) =>
  __createResponse(await __call("api", { method: method, path: String(path), body: body }));
// At most once per key (the host's ledger, worker-sandbox.ts "Effects"): a
// closure cannot cross to the host, so begin and finish are two calls and fn
// runs here, between them.
const __effect = async (key, fn, options) => {
  if (typeof fn !== "function") throw new TypeError("kitsuden.effect(key, fn): fn must be a function");
  const k = String(key);
  const o = options || {};
  const begun = await __call("effect", {
    phase: "begin", key: k, retryUnknown: o.retryUnknown === true, staleAfterMs: o.staleAfterMs,
  });
  if (begun.decision === "done") return begun.result;
  let result;
  try {
    result = await fn();
  } catch (e) {
    await __call("effect", { phase: "finish", key: k, ok: false, error: String((e && e.message) || e) });
    throw e;
  }
  await __call("effect", { phase: "finish", key: k, ok: true, result: result === undefined ? null : result });
  return result;
};
const kitsuden = Object.freeze({
  fetch, env, event,
  effect: __effect,
  log: (m) => console.log(m),
  api: Object.freeze({
    request: (method, path, body) => __api(String(method).toUpperCase(), path, body),
    get: (path) => __api("GET", path),
    post: (path, body) => __api("POST", path, body),
    put: (path, body) => __api("PUT", path, body),
    patch: (path, body) => __api("PATCH", path, body),
    delete: (path) => __api("DELETE", path),
  }),
});
globalThis.__run = async () => {
  const r = await (async (event, env, console, kitsuden, fetch) => {
    /*__CODE__*/
  })(event, env, console, kitsuden, fetch);
  return r === undefined ? "null" : JSON.stringify(r);
};
`;

function fail(error, logs = "", memory = 0) {
  write({ t: "fin", result: null, logs, error, memory });
}

async function main() {
  const m = await initialMessage();
  const limits = m.limits || {};
  const maxMemory = Math.max(4, Number(limits.memoryMb) || 64) * 1024 * 1024;
  const stack = Math.max(64 * 1024, Number(limits.stackBytes) || 512 * 1024);
  const time = Math.max(10, Number(limits.timeMs) || 5000);
  const maxLogs = Math.max(1000, Number(limits.logsBytes) || 50_000);
  const maxResult = Math.max(1000, Number(limits.resultBytes) || 1_000_000);

  const { newQuickJSWASMModuleFromVariant, newVariant } = await import(coreUrl);
  const base = (await import(variantUrl)).default;
  // HARD memory cap: the whole WASM cannot grow beyond this.
  // `setMemoryLimit` alone is not enough: measured, `new Array(1e5).fill()`
  // in a loop took the process to 1.6 GB before the «out of memory» (the module's
  // default memory reaches 2 GB). With `maximum`, the interpreter's
  // malloc fails on reaching the cap and the code receives its InternalError.
  const pages = Math.ceil((maxMemory + 32 * 1024 * 1024) / 65536);
  const variant = newVariant(base, {
    wasmMemory: new WebAssembly.Memory({ initial: Math.min(256, pages), maximum: pages }),
  });
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(maxMemory);
  rt.setMaxStackSize(stack);
  // CPU: QuickJS calls this handler every so many instructions.
  // An infinite loop is cut off here; if the host also hangs, the parent
  // kills the process on timeout.
  const limit = Date.now() + time;
  rt.setInterruptHandler(() => Date.now() > limit);
  const ctx = rt.newContext();

  const logs = [];
  let tamLogs = 0;
  const log = ctx.newFunction("__log", (level, text) => {
    const line = `[${ctx.getString(level)}] ${ctx.getString(text)}`;
    if (tamLogs + line.length <= maxLogs) {
      logs.push(line);
      tamLogs += line.length;
    }
  });
  ctx.setProp(ctx.global, "__log", log);
  log.dispose();

  let next = 0;
  const request = ctx.newFunction("__request", (op, args) => {
    const id = ++next;
    const operation = ctx.getString(op);
    const argsObject = ctx.getString(args);
    const deferred = ctx.newPromise();
    responses.set(id, (r) => {
      if (!ctx.alive) return;
      const s = ctx.newString(
        JSON.stringify(r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error })
      );
      deferred.resolve(s);
      s.dispose();
      deferred.dispose();
      rt.executePendingJobs();
    });
    let parsed = null;
    try {
      parsed = JSON.parse(argsObject);
    } catch {
      parsed = null;
    }
    write({ t: "call", id, op: operation, args: parsed });
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__request", request);
  request.dispose();

  for (const [name, value] of [
    ["__event", JSON.stringify(m.event ?? {})],
    ["__env", JSON.stringify(m.env ?? {})],
  ]) {
    const h = ctx.newString(value);
    ctx.setProp(ctx.global, name, h);
    h.dispose();
  }

  const memory = () => {
    try {
      const h = rt.computeMemoryUsage();
      const d = ctx.dump(h);
      h.dispose();
      return Number(d?.memory_used_size) || 0;
    } catch {
      return 0;
    }
  };
  const messageOf = (h) => {
    const e = ctx.dump(h);
    h.dispose();
    if (e && typeof e === "object") return String(e.message ?? e.name ?? JSON.stringify(e));
    return String(e);
  };

  const source = PROLOGUE.replace("/*__CODE__*/", () => String(m.code ?? ""));
  const prepared = ctx.evalCode(source, "action.js");
  if (prepared.error) {
    return fail(messageOf(prepared.error), logs.join("\n"), memory());
  }
  prepared.value.dispose();

  const call = ctx.evalCode("__run()", "start.js");
  if (call.error) {
    return fail(messageOf(call.error), logs.join("\n"), memory());
  }
  const promise = ctx.resolvePromise(call.value);
  call.value.dispose();
  rt.executePendingJobs();

  const final = await promise;
  if (final.error) {
    return fail(messageOf(final.error), logs.join("\n"), memory());
  }
  const text = ctx.getString(final.value);
  final.value.dispose();
  if (text.length > maxResult) {
    return fail(
      `Result too large (${text.length} bytes, max ${maxResult})`,
      logs.join("\n"),
      memory()
    );
  }
  write({
    t: "fin",
    result: JSON.parse(text),
    logs: logs.join("\n"),
    error: null,
    memory: memory(),
  });
}

main()
  .catch((err) => fail(err?.message || String(err)))
  .finally(() => {
    // Without `dispose`: the process ends now, and a live handle must not turn
    // a good result into a QuickJS assertion.
    // The empty write completes AFTER the previous ones: exiting earlier
    // would cut the result line on a slow pipe (Windows).
    process.stdout.write("", () => process.exit(0));
  });
