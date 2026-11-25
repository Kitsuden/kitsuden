# Workers: a kon's long-running processes

Some kons need something that stays open: a bot keeps a socket to Discord's
gateway, a connector polls a mailbox that has no webhooks. A route only answers
requests, and a [schedule](schedules.md) only ticks. Opening the socket in
`onStartup` opens one per replica (two bots answering every message) and never
comes back after a crash. A worker is that process, run by the core:

```ts
import { defineKon } from "@kitsuden/shared";

export default defineKon({
  id: "kon-dc",
  // …
  workers: [
    {
      id: "gateway",
      description: "Discord gateway connection",
      async run(ctx, worker) {
        const socket = await connect(ctx);
        worker.signal.addEventListener("abort", () => socket.close());
        for await (const event of socket) {
          // Receive here, process in a queue handler (below)
          await ctx.queue!.add("inbound", "event", event, { dedupeKey: event.id });
        }
      },
    },
  ],
});
```

## What the core guarantees

- **One instance across every replica and process.** The worker holds a
  Postgres advisory lock on a connection of its own for as long as it runs. The
  other processes try again every 15 seconds; if the connection drops, the
  worker here is stopped and another process takes it.
- **It stops** (`worker.signal` aborts) on shutdown, when the kon is switched
  off in the panel (checked every 10 seconds) and when the lock is lost.
  `run()` must return soon after: the core waits 10 seconds.
- **It restarts after a crash.** Throwing, or returning while the signal is not
  aborted, is a crash: it starts again after 1, 2, 4… seconds, at most 60. The
  pause resets after 5 minutes of healthy running. The last error and the count
  of restarts are in the worker list of this process.
- **It runs as the system**: no request and no user, in the kon's scope (its
  queue namespace, its secrets).

## The contract

```ts
interface KonWorker {
  id: string; // `gateway`: lower case letters, digits and '-'; full name `dc:gateway`
  description?: string;
  run(ctx: KonContext, worker: KonWorkerRuntime): Promise<void>;
}

interface KonWorkerRuntime {
  signal: AbortSignal; // shutdown, kon switched off, lock lost
  workerId: string; // `dc:gateway`
  attempt: number; // restarts so far in this process
}
```

`ctx` is the **same object** the kon's `createRouter(ctx)` and
`operations(ctx)` receive in that process, so state kept per context (a
`WeakMap` keyed on it) is shared between the routes and the worker. When the
kon is loaded again (enabled after being switched off), a new context is made
and the old worker is stopped: release what you keyed on the old one when its
signal aborts.

## Receive in the worker, process in the queue

A worker should do as little as possible: hold the connection and hand each
event to the [queue](queues.md). The handler, registered as usual in the kon's
setup, runs on any process with a queue worker, with retries and a dead letter
visible in the panel:

```ts
// In the kon's setup / onStartup
ctx.queue!.handle("inbound", async (job) => handleEvent(ctx, job.payload));
```

`dedupeKey` with the provider's own id makes a reconnect that replays events
harmless.

## Worker or schedule?

| You need                                 | Use                      |
| ---------------------------------------- | ------------------------ |
| work every N minutes or at a time of day | [schedule](schedules.md) |
| a connection that must stay open         | worker                   |
| polling more often than once a minute    | worker                   |
| state kept in memory between passes      | worker                   |

## Where it runs

The same image and the same start command for every role; the environment
decides (`docker-compose.yml`):

| `KITSUDEN_WORKERS` | This process                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `inline` (default) | serves requests **and** runs the workers of active kons                       |
| `off`              | runs no workers (set it on the API when a worker service runs them)           |
| `only`             | a worker process: runs workers and queue jobs; no ports, so no public traffic |

To move workers out of the API process:

```bash
# .env
KITSUDEN_WORKERS=off
```

```bash
docker compose --profile workers up -d    # starts kitsuden_worker (KITSUDEN_WORKERS=only)
```

`KITSUDEN_WORKER_FILTER=dc:gateway,koe:*` narrows what one process takes, for
example one worker service per kon.

## A kon that must also run on an older core

A core without workers ignores the `workers` field, so the work would never
run. Every core that runs workers sets `ctx.workers` (`{ supported: true }`),
whatever `KITSUDEN_WORKERS` says (with `off` the workers run in another
process, not nowhere). Keep the old way only when it is absent:

```ts
if (!ctx.workers) startLegacyInterval(ctx); // older core: no workers
```
