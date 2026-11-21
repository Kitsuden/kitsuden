# Periodic tasks: `defineKon({ schedules })`

A kon that keeps another system in step (an ERP, a mailbox, a feed) needs a
clock. Declare it; the host runs each tick **once across every replica** of the
API, on the durable [job queue](../install/queue.md).

```ts
import { defineKon } from "@kitsuden/shared";

export default defineKon({
  id: "kon-odoo",
  // …
  schedules: [
    {
      id: "sync-partners",
      cron: "*/15 * * * *", // every 15 minutes
      timezone: "Europe/Madrid", // optional, default UTC
      description: "Pull partners changed in Odoo since the last tick",
      attempts: 2, // optional, 1 to 5, default 1
      async run(ctx, { scheduledAt }) {
        // `scheduledAt` is the tick, the same on every replica: use it as "now".
        await syncPartnersChangedBefore(ctx, scheduledAt);
      },
    },
  ],
});
```

| Field         | Rules                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `id`          | lower case letters, digits and `-`, unique in the kon                                     |
| `cron`        | 5 fields (minute first) or 6 (second first)                                               |
| `timezone`    | an IANA name; the expression is read in it                                                |
| `attempts`    | retries of a run that throws, with the queue's backoff; keep them shorter than the period |
| `run(ctx, …)` | the work; runs as the system (no request, no user)                                        |

A malformed schedule is reported when the kon loads and skipped; the kon's
routes and its other schedules still load.

## What runs where

1. Every API process keeps the same timers.
2. When one fires, the process **claims the tick**: one row per schedule and
   scheduled instant in `kitsuden_schedule_ticks` (migration `0091`), through
   the `SECURITY DEFINER` function `kitsuden_schedule_claim`. The first process
   wins; the others skip that tick.
3. The winner queues a job on `kitsuden-kon-schedules` (a system queue: never
   charged to an agent). Any process with a worker runs it, with the queue's
   lease, retries and dead letter (panel → Queue). A process started with
   `QUEUE_WORKER=false` still claims and queues.

A kon disabled since it loaded (at startup or from the panel) skips its ticks,
and a run already queued for it does nothing. A job whose schedule the kon no
longer declares (updated, uninstalled) fails at once (`PermanentError`), without
retries.

## What to keep in mind

- **At least once.** Like every queued job, a run whose process dies holding the
  lease runs again. Make `run` idempotent: upsert, compare timestamps, keep a
  watermark.
- **Use `scheduledAt`, not `new Date()`.** A run may start seconds after its
  tick (a busy worker, a retry); the tick is the instant the work is about.
- **A missed tick is not caught up.** If no API process is running at 03:00,
  the 03:00 run does not happen later. Work that must not be skipped reads its
  own watermark ("everything changed since my last success") instead of
  assuming the previous tick ran.
- **No overlap inside a process**, but a long run can meet the next tick on
  another worker. Keep the period longer than the work, or guard with your own
  lock.

The same claim now applies to the core's `cron` actions and rules: they used to
fire once in every API process ([automation.md](../automation.md#limits)).
