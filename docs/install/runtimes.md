# Runtimes: Bun, Node, a single binary, edge

## Bun (default)

`bun run src/index.ts` (dev) or `bun run dist/index.js` (the image). Bun uses
the `export default` of `apps/api/src/index.ts` as its server, with the
realtime WebSockets at `/api/realtime`.

## Node 22+ (supported, checked in CI)

The same Hono app runs on Node through `@hono/node-server`
(`apps/api/src/node-server.ts`). Bun is only needed to **build** it:

```bash
cd apps/api
pnpm run build:node        # bun build … --target node → dist-node/node-server.js
pnpm run start:node        # node dist-node/node-server.js
```

- Everything works except the realtime WebSockets (`/api/realtime` answers
  `501`); REST, MCP, Server-Sent Events, the queue and the traces do.
- `sharp` and `@node-rs/argon2` stay external (native modules, installed by
  `pnpm install` for the platform).
- File access goes through `lib/file.ts` (`Bun.file` under Bun, `node:fs`
  under Node); do not call `Bun.*` directly in the API.
- CI job **API on Node 22 (no Valkey)** builds it, starts it with Node against
  Postgres only, and checks `/api/health` (2026-10-28: checked locally with
  Node 22.19, `database: ok`).

Why it matters: Bun is still young with some native modules; keeping Node as a
working fallback means a Bun regression never takes the API down.

## A single binary (`bun build --compile`): not viable today

Tried on 2026-10-28 (Bun 1.3.14, Windows x64):

```bash
bun build src/index.ts --compile --outfile kitsuden-api
```

- It **compiles**: 2,680 modules, a 118 MB executable, in about 4 s.
- It **does not start**: `Could not load the "sharp" module using the win32-x64
runtime`. `sharp` loads its native `.node` addon by a computed path at
  runtime, which the binary's embedded filesystem cannot serve. `@node-rs/argon2`
  (agent key hashing, needed on every agent request) has the same shape.
- Kons are discovered **on disk at startup** (`packages/kons`, `kitsuden.kons.json`)
  and imported dynamically, so a binary built without them cannot load kons
  installed later.

What would make it viable: the two native modules shipped next to the binary
(`--external` + a small `node_modules`), images processed lazily so the API
can start without `sharp`, and kons compiled in at build time. That is a
"binary plus a folder", not a single file, so the container image remains the
recommended distribution. Revisit if Bun gains embedded native addons.

## Edge / serverless: not a target

Kitsuden is meant to run as a **persistent container next to its Postgres**:

- one warm connection pool per process, and one local transaction per request
  for RLS (`SET LOCAL`), which needs low latency to the database;
- a queue worker and a `LISTEN` connection that live as long as the process;
- traces flushed in batches every few seconds.

Workers/Edge runtimes (no long-lived sockets, cold starts, a database across
the internet) break those assumptions. Run the API as a container (the image,
or `bun`/`node` on a VM), with Postgres on the same network.
