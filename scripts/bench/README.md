# Load benchmark

A repeatable load test of a running Kitsuden API, to compare two versions on
the same machine. It measures latency (p50, p95, p99), requests per second and
errors with [autocannon](https://github.com/mcollina/autocannon) (pinned to
8.0.0), and samples Postgres pool usage and the API's CPU from `/metrics`
during each run. The figures measured so far, and what they mean, are in
[docs/agents/benchmarks.md](../../docs/agents/benchmarks.md#3-load-and-latency).

**Never run it against production.** It is a load test, and the write
scenarios insert rows (into the dataset you name, through the API, as the
agent you name). Use a copy: a restored dump in a throwaway Postgres, with the
API connecting as a non-superuser role so that RLS applies as in production.

## Setup

```bash
node scripts/bench/bench.mjs setup     # installs autocannon@8.0.0 in scripts/bench/.tools (git-ignored)
```

`BENCH_TOOLS_DIR` points somewhere else if you prefer.

Then, on the API under test (environment of the API, not of the benchmark):

- `METRICS_TOKEN` (16+ characters): lets the benchmark read pool and CPU from
  `/metrics` (`kitsuden_db_pool_connections`, `kitsuden_db_pool_waiting`,
  `process_cpu_seconds_total`). Without it those columns show `-`.
- `SITE_API_KEY`: the per-route limiter allows 300 requests per minute per
  client, and a benchmark is one client. With the site key, requests are
  signed as site visitors (as the sites' server-side rendering does) and spread
  over `BENCH_VISITORS` (5000) of them. The limiter still runs on every request;
  it just does not cut the load.
- An agent for the agent and MCP scenarios, created in the copy, with a high
  `rate_limit` (its per-minute quota is checked on every request too), for
  example scopes `mcp:connect mcp:read mcp:write datasets:*:read datasets:*:write`.
- A dataset the write scenarios can insert into.

## Run

```bash
export BENCH_API=http://127.0.0.1:3001
export BENCH_SITE_KEY=...            # the API's SITE_API_KEY
export BENCH_COOKIE='better-auth.session_token=...'   # a session, for the authenticated scenarios
export BENCH_AGENT_KEY=kitsuden_agent_...
export BENCH_DATASET_ID=<uuid of a dataset with rows>
export BENCH_WRITE_DATASET_ID=<uuid of a dataset to write into>
export BENCH_METRICS_TOKEN=...       # the API's METRICS_TOKEN

node scripts/bench/bench.mjs list
node scripts/bench/bench.mjs run --connections=50 --sweep=50,100,200 --duration=10 --warmup=3 --out=after.json
node scripts/bench/compare.mjs before.json after.json
```

Secrets go in the environment, never in a file in the repository. A scenario
whose variables are missing is skipped and says which one.

| Scenario                    | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `anon-games`                | `GET /api/games?limit=20`, anonymous                                                 |
| `anon-blog`                 | `GET /api/blog?limit=20`, anonymous (sweep)                                          |
| `anon-datasets`             | `GET /api/data-sets`, anonymous                                                      |
| `anon-entries`              | `GET /api/data-sets/:id/entries?limit=50`, anonymous, RLS transaction (sweep)        |
| `anon-page-builder`         | `GET /api/page-builder/block-types`, anonymous                                       |
| `anon-games-format-auto`    | the games list with `Accept: application/vnd.kitsuden.auto`                          |
| `auth-entries`, `auth-blog` | the same reads with a session cookie                                                 |
| `agent-entries`             | dataset entries with `Bearer kitsuden_agent_*` (sweep)                               |
| `agent-settings`            | `GET /api/settings` as the agent (auth, quotas and gates, little data)               |
| `agent-entries-format-auto` | agent entries in `auto` format                                                       |
| `agent-write-idempotent`    | `POST /api/datasets/:id/entries` with a new `Idempotency-Key` each time              |
| `agent-write-replay`        | the same key and body every time: the stored response is replayed                    |
| `mcp-tools-list`            | MCP `tools/list` over one session                                                    |
| `mcp-call-hardcoded`        | MCP `tools/call kitsuden_query_dataset` (limit 20)                                   |
| `mcp-call-sdk`              | MCP `tools/call datasets__list-entries` (limit 20, through the SDK pipeline) (sweep) |

`--sweep` repeats the scenarios marked "sweep" at each connection count.

## Telling a change from noise

On a shared machine the numbers move between runs, sometimes by 30 % or more.
Compare versions by interleaving them on the same machine in the same hour:
A, B, A, B; then `compare.mjs --a=a1.json,a2.json --b=b1.json,b2.json` takes the
median of each side.

## Per-middleware timing

To see where a request spends its time, start the API with
`KITSUDEN_PROFILE_MIDDLEWARE=/path/to/profile.json` (off by default). Every
global `app.use` middleware is wrapped to record its own time (before calling
`next()` plus after it returns), and the summary (calls, total, mean, p95) is
written to that file every 5 s and on exit. It does not change what any
middleware does or their order; it is a measuring tool, not for production.
Route handlers are not wrapped: their time is what is left of the request.
