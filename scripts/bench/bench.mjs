#!/usr/bin/env node
/**
 * Kitsuden load benchmark
 * ============================================================================
 *
 * Runs a fixed set of HTTP scenarios against a RUNNING Kitsuden API with
 * autocannon and prints p50/p95/p99 latency, requests per second, errors,
 * Postgres pool usage and API CPU for each one. Results go to a JSON file so
 * two versions can be compared with `compare.mjs`.
 *
 * Never point it at production: it writes (the idempotent-write scenarios
 * create rows) and it is a load test. See README.md.
 *
 *   node scripts/bench/bench.mjs setup                  install the pinned autocannon
 *   node scripts/bench/bench.mjs list                   list scenarios
 *   node scripts/bench/bench.mjs run [options]          run them
 *
 * Options for `run`:
 *   --only=a,b         only these scenarios (names or prefixes)
 *   --connections=50   concurrent connections (default 50)
 *   --sweep=50,100,200 run the sweep scenarios at these connection counts
 *   --duration=10      seconds measured per scenario (default 10)
 *   --warmup=3         seconds of warm-up per scenario, not measured (default 3)
 *   --out=file.json    where to write the results (default bench-<date>.json)
 *   --label=text       a label stored in the results (e.g. "before", "after")
 *
 * Environment (secrets come from the environment, never from files in the repo):
 *   BENCH_API                 API base URL (default http://127.0.0.1:3001)
 *   BENCH_SITE_KEY            the API's SITE_API_KEY. With it, anonymous and
 *                             cookie requests are spread over BENCH_VISITORS
 *                             signed site visitors, as the sites' SSR does, so
 *                             the per-route limiter (300/min per client) runs on
 *                             every request without cutting the load
 *   BENCH_VISITORS            how many visitors (default 5000)
 *   BENCH_COOKIE              session cookie of a user (authenticated scenarios)
 *   BENCH_AGENT_KEY           kitsuden_agent_* key (agent and MCP scenarios). Its
 *                             agent needs a high rate_limit or it gets 429s
 *   BENCH_DATASET_ID          dataset whose entries are read
 *   BENCH_WRITE_DATASET_ID    dataset the write scenarios insert into
 *   BENCH_METRICS_TOKEN       the API's METRICS_TOKEN: samples pool and CPU
 *                             from /metrics once a second during each run
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION_AUTOCANNON = "8.0.0";
const TOOLS = process.env.BENCH_TOOLS_DIR ?? join(HERE, ".tools");

const env = process.env;
const API = (env.BENCH_API ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const SITE = env.BENCH_SITE_KEY ?? "";
const VISITORS = Number(env.BENCH_VISITORS ?? 5000);
const COOKIE = env.BENCH_COOKIE ?? "";
const AGENT = env.BENCH_AGENT_KEY ?? "";
const DATASET = env.BENCH_DATASET_ID ?? "";
const DATASET_WRITE = env.BENCH_WRITE_DATASET_ID ?? "";
const METRICS_TOKEN = env.BENCH_METRICS_TOKEN ?? "";

// ── Arguments ───────────────────────────────────────────────────────────────

const [order = "run", ...rest] = process.argv.slice(2);
const options = Object.fromEntries(
  rest
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.length ? v.join("=") : "true"];
    })
);

// ── Scenarios ───────────────────────────────────────────────────────────────

let nextVisitor = 0;
/** Headers of a signed site visitor (if there is a key): one bucket per visitor. */
function visitor() {
  if (!SITE) return {};
  nextVisitor = (nextVisitor + 1) % VISITORS;
  return { "x-kitsuden-site": SITE, "x-kitsuden-client": `bench-${nextVisitor}` };
}

/** An agent also goes through the per-route limiter (300/min per client): with the site key, per visitor. */
const ofAgent = () => ({ ...visitor(), authorization: `Bearer ${AGENT}` });
const run = Date.now().toString(36);
let counter = 0;

/**
 * Each scenario: `needs` (which variables), `request()` (method, path,
 * headers, body; called on EVERY request), `sweep` (whether it takes part in
 * the connection sweep) and optional `prepare` (before measuring).
 */
const SCENARIOS = [
  {
    name: "anon-games",
    group: "anonymous",
    request: () => ({ path: "/api/games?limit=20", headers: visitor() }),
  },
  {
    name: "anon-blog",
    group: "anonymous",
    sweep: true,
    request: () => ({ path: "/api/blog?limit=20", headers: visitor() }),
  },
  {
    name: "anon-datasets",
    group: "anonymous",
    request: () => ({ path: "/api/data-sets", headers: visitor() }),
  },
  {
    name: "anon-entries",
    group: "anonymous",
    needs: ["BENCH_DATASET_ID"],
    sweep: true,
    request: () => ({ path: `/api/data-sets/${DATASET}/entries?limit=50`, headers: visitor() }),
  },
  {
    name: "anon-page-builder",
    group: "anonymous",
    request: () => ({ path: "/api/page-builder/block-types", headers: visitor() }),
  },
  {
    name: "anon-games-format-auto",
    group: "format=auto",
    request: () => ({
      path: "/api/games?limit=20&format=auto",
      headers: { ...visitor(), accept: "application/vnd.kitsuden.auto" },
    }),
  },
  {
    name: "auth-entries",
    group: "authenticated",
    needs: ["BENCH_COOKIE", "BENCH_DATASET_ID"],
    request: () => ({
      path: `/api/data-sets/${DATASET}/entries?limit=50`,
      headers: { ...visitor(), cookie: COOKIE },
    }),
  },
  {
    name: "auth-blog",
    group: "authenticated",
    needs: ["BENCH_COOKIE"],
    request: () => ({ path: "/api/blog?limit=20", headers: { ...visitor(), cookie: COOKIE } }),
  },
  {
    name: "agent-entries",
    group: "agent REST",
    needs: ["BENCH_AGENT_KEY", "BENCH_DATASET_ID"],
    sweep: true,
    request: () => ({ path: `/api/data-sets/${DATASET}/entries?limit=20`, headers: ofAgent() }),
  },
  {
    name: "agent-settings",
    group: "agent REST",
    needs: ["BENCH_AGENT_KEY"],
    request: () => ({ path: "/api/settings", headers: ofAgent() }),
  },
  {
    name: "agent-entries-format-auto",
    group: "format=auto",
    needs: ["BENCH_AGENT_KEY", "BENCH_DATASET_ID"],
    request: () => ({
      path: `/api/data-sets/${DATASET}/entries?limit=50`,
      headers: { ...ofAgent(), accept: "application/vnd.kitsuden.auto" },
    }),
  },
  {
    name: "agent-write-idempotent",
    group: "idempotent writes",
    needs: ["BENCH_AGENT_KEY", "BENCH_WRITE_DATASET_ID"],
    request: () => {
      const n = ++counter;
      return {
        method: "POST",
        path: `/api/datasets/${DATASET_WRITE}/entries`,
        headers: {
          ...ofAgent(),
          "content-type": "application/json",
          "idempotency-key": `bench-${run}-${n}`,
        },
        body: JSON.stringify({ title: `bench ${run} ${n}`, data: { n, note: "bench" } }),
      };
    },
  },
  {
    name: "agent-write-replay",
    group: "idempotent writes",
    needs: ["BENCH_AGENT_KEY", "BENCH_WRITE_DATASET_ID"],
    prepare: async (e) => {
      e.sets = {
        method: "POST",
        path: `/api/datasets/${DATASET_WRITE}/entries`,
        headers: {
          ...ofAgent(),
          "content-type": "application/json",
          "idempotency-key": `bench-replay-${run}`,
        },
        body: JSON.stringify({ title: `bench replay ${run}`, data: { n: 0, note: "replay" } }),
      };
      const r = await fetch(API + e.sets.path, {
        method: "POST",
        headers: e.sets.headers,
        body: e.sets.body,
      });
      if (r.status >= 300) throw new Error(`the first write answered ${r.status}`);
    },
    // Same key and body; the visitor changes (it only counts for the per-route limiter)
    request: (e) => ({ ...e.sets, headers: { ...e.sets.headers, ...visitor() } }),
  },
  ...["tools/list", "hardcoded", "sdk"].map((type) => ({
    name: type === "tools/list" ? "mcp-tools-list" : `mcp-call-${type}`,
    group: "MCP",
    needs: type === "tools/list" ? ["BENCH_AGENT_KEY"] : ["BENCH_AGENT_KEY", "BENCH_DATASET_ID"],
    sweep: type === "sdk",
    prepare: openMcpSession,
    close: (e) => e.session?.close(),
    request: (e) => ({
      method: "POST",
      path: e.session.path,
      headers: { ...ofAgent(), "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++counter,
        method: type === "tools/list" ? "tools/list" : "tools/call",
        params:
          type === "tools/list"
            ? {}
            : type === "hardcoded"
              ? { name: "kitsuden_query_dataset", arguments: { datasetId: DATASET, limit: 20 } }
              : { name: "datasets__list-entries", arguments: { id: DATASET, limit: 20 } },
      }),
    }),
  })),
];

/** Opens an MCP (SSE) session and leaves its message path in `e.session`. */
async function openMcpSession(e) {
  const control = new AbortController();
  const r = await fetch(`${API}/api/mcp`, { headers: ofAgent(), signal: control.signal });
  if (!r.ok) throw new Error(`GET /api/mcp answered ${r.status}`);
  const reader = r.body.getReader();
  let text = "";
  while (!/data: (\S+)/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the MCP stream closed before the endpoint event");
    text += new TextDecoder().decode(value);
  }
  const path = /data: (\S+)/.exec(text)[1];
  const init = await fetch(API + path, {
    method: "POST",
    headers: { ...ofAgent(), "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "kitsuden-bench", version: "1" },
      },
    }),
  });
  if (!init.ok) throw new Error(`initialize answered ${init.status}`);
  e.session = { path, close: () => control.abort() };
}

// ── Tools ───────────────────────────────────────────────────────────────────

function loadAutocannon() {
  const require = createRequire(join(TOOLS, "package.json"));
  try {
    return require("autocannon");
  } catch {
    console.error(`autocannon not found in ${TOOLS}. Run: node scripts/bench/bench.mjs setup`);
    process.exit(2);
  }
}

function install() {
  mkdirSync(TOOLS, { recursive: true });
  if (!existsSync(join(TOOLS, "package.json"))) {
    writeFileSync(
      join(TOOLS, "package.json"),
      JSON.stringify({ name: "kitsuden-bench-tools", private: true }, null, 2)
    );
  }
  execFileSync(
    "npm",
    ["install", `autocannon@${VERSION_AUTOCANNON}`, "--no-fund", "--no-audit", "--save-exact"],
    {
      cwd: TOOLS,
      stdio: "inherit",
      shell: process.platform === "win32",
    }
  );
}

// ── Server metrics ──────────────────────────────────────────────────────────

async function readMetrics() {
  if (!METRICS_TOKEN) return null;
  try {
    const r = await fetch(`${API}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const t = await r.text();
    const value = (re) => {
      const m = re.exec(t);
      return m ? Number(m[1]) : null;
    };
    return {
      at: performance.now(),
      cpu: value(/^process_cpu_seconds_total ([\d.]+)/m),
      total: value(/^kitsuden_db_pool_connections\{state="total"\} (\d+)/m),
      idle: value(/^kitsuden_db_pool_connections\{state="idle"\} (\d+)/m),
      max: value(/^kitsuden_db_pool_connections\{state="max"\} (\d+)/m),
      waiting: value(/^kitsuden_db_pool_waiting (\d+)/m),
    };
  } catch {
    return null;
  }
}

function sampler() {
  const samples = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const m = await readMetrics();
      if (m) samples.push(m);
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return async () => {
    stop = true;
    await loop;
    const fin = await readMetrics();
    if (fin) samples.push(fin);
    if (samples.length < 2 || samples[0].cpu === null) return null;
    const a = samples[0];
    const b = samples[samples.length - 1];
    const inUse = samples.map((m) => (m.total ?? 0) - (m.idle ?? 0));
    return {
      cpuPercent: Math.round(((b.cpu - a.cpu) / ((b.at - a.at) / 1000)) * 1000) / 10,
      poolMax: a.max,
      poolInUseMax: Math.max(...inUse),
      poolInUseAvg: Math.round((inUse.reduce((s, x) => s + x, 0) / inUse.length) * 10) / 10,
      poolWaitingMax: Math.max(...samples.map((m) => m.waiting ?? 0)),
      samples: samples.length,
    };
  };
}

// ── Measuring ───────────────────────────────────────────────────────────────

function percentile(sortedItems, p) {
  if (sortedItems.length === 0) return null;
  const i = Math.min(sortedItems.length - 1, Math.ceil((p / 100) * sortedItems.length) - 1);
  return Math.round(sortedItems[Math.max(0, i)] * 10) / 10;
}

function load(autocannon, e, connections, seconds, measure) {
  return new Promise((resolve, reject) => {
    const latencies = [];
    const statuses = {};
    const instance = autocannon(
      {
        url: API,
        connections: connections,
        duration: seconds,
        timeout: 30,
        requests: [
          {
            setupRequest: (req) => {
              const p = e.request(e);
              return {
                ...req,
                method: p.method ?? "GET",
                path: p.path,
                headers: p.headers ?? {},
                body: p.body,
              };
            },
          },
        ],
      },
      (err, res) => (err ? reject(err) : resolve({ res, latencies: latencies, statuses }))
    );
    if (measure) {
      instance.on("response", (_client, status, _bytes, ms) => {
        latencies.push(ms);
        statuses[status] = (statuses[status] ?? 0) + 1;
      });
    }
  });
}

async function scenario(autocannon, e, connections, seconds, warmup) {
  for (const v of e.needs ?? []) {
    if (!env[v]) return { name: e.name, skipped: `missing ${v}` };
  }
  try {
    if (e.prepare) await e.prepare(e);
    if (warmup > 0) await load(autocannon, e, connections, warmup, false);
    const stopSamples = sampler();
    const {
      res,
      latencies: latencies,
      statuses,
    } = await load(autocannon, e, connections, seconds, true);
    const server = await stopSamples();
    latencies.sort((a, b) => a - b);
    const total = latencies.length;
    const bad = Object.entries(statuses)
      .filter(([s]) => Number(s) >= 400)
      .reduce((s, [, n]) => s + n, 0);
    return {
      name: e.name,
      group: e.group,
      connections,
      seconds,
      requests: total,
      rps: Math.round((total / res.duration) * 10) / 10,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: total ? Math.round(latencies[total - 1] * 10) / 10 : null,
      statuses,
      errors: bad + res.errors + res.timeouts,
      networkErrors: res.errors,
      timeouts: res.timeouts,
      bytesPerSecond: Math.round(res.throughput.average),
      server,
    };
  } catch (err) {
    return { name: e.name, failure: err.message };
  } finally {
    e.close?.(e);
  }
}

function table(results) {
  const rows = [
    [
      "scenario",
      "conn",
      "req/s",
      "p50 ms",
      "p95 ms",
      "p99 ms",
      "errors",
      "CPU %",
      "pool in use (max/avg)",
      "pool waiting max",
    ],
  ];
  for (const r of results) {
    if (r.skipped || r.failure) {
      rows.push([r.name, "", r.skipped ?? `FAILED: ${r.failure}`, "", "", "", "", "", "", ""]);
      continue;
    }
    const s = r.server;
    rows.push([
      r.name,
      String(r.connections),
      String(r.rps),
      String(r.p50),
      String(r.p95),
      String(r.p99),
      r.errors
        ? `${r.errors} ${JSON.stringify(Object.fromEntries(Object.entries(r.statuses).filter(([k]) => Number(k) >= 400)))}`
        : "0",
      s ? String(s.cpuPercent) : "-",
      s ? `${s.poolInUseMax}/${s.poolInUseAvg} of ${s.poolMax}` : "-",
      s ? String(s.poolWaitingMax) : "-",
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((f) => f[i].length)));
  return rows.map((f) => f.map((c, i) => c.padEnd(widths[i])).join("  ")).join("\n");
}

async function principal() {
  if (order === "setup") return install();
  if (order === "list") {
    for (const e of SCENARIOS)
      console.log(`${e.name.padEnd(28)} ${e.group}${e.sweep ? " (sweep)" : ""}`);
    return;
  }
  if (order !== "run") {
    console.error(
      "usage: bench.mjs setup | list | run [--only=…] [--connections=50] [--sweep=50,100,200] [--duration=10] [--warmup=3] [--out=…]"
    );
    process.exit(2);
  }
  const autocannon = loadAutocannon();
  const connections = Number(options.connections ?? 50);
  const seconds = Number(options.duration ?? 10);
  const warmup = Number(options.warmup ?? 3);
  const sweep = options.sweep
    ? options.sweep
        .split(",")
        .map(Number)
        .filter((n) => n > 0)
    : [];
  const only = options.only ? options.only.split(",") : null;
  const chosenItems = SCENARIOS.filter(
    (e) => !only || only.some((s) => e.name === s || e.name.startsWith(s))
  );

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`${API}/health is not answering 200`);
    process.exit(1);
  }

  const results = [];
  for (const e of chosenItems) {
    const r = await scenario(autocannon, e, connections, seconds, warmup);
    results.push(r);
    console.error(
      `  ${e.name} @${connections}: ${r.skipped ?? r.failure ?? `${r.rps} req/s, p50 ${r.p50} ms, p99 ${r.p99} ms, ${r.errors} errors`}`
    );
  }
  for (const n of sweep) {
    if (n === connections) continue;
    for (const e of chosenItems.filter((x) => x.sweep)) {
      const r = await scenario(autocannon, e, n, seconds, warmup);
      results.push(r);
      console.error(
        `  ${e.name} @${n}: ${r.skipped ?? r.failure ?? `${r.rps} req/s, p50 ${r.p50} ms, p99 ${r.p99} ms, ${r.errors} errors`}`
      );
    }
  }

  const output = options.out ?? `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const report = {
    label: options.label ?? null,
    api: API,
    when: new Date().toISOString(),
    id: randomUUID(),
    node: process.version,
    autocannon: VERSION_AUTOCANNON,
    options: { connections, seconds, warmup, sweep, visitors: SITE ? VISITORS : 0 },
    results,
  };
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(table(results));
  console.log(`\nresults: ${output}`);
}

await principal();
