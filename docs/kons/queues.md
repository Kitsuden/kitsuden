# Kon queues: each kon has its own namespace

A kon runs background work on the core's [Postgres queue](../install/queue.md).
The queue is one table and one set of handlers for the whole API process, so
queue names are scoped per kon, the same way [event names](events.md) are. A
kon handles and queues jobs only on its own queues. It cannot take over another
kon's queue or the core's (`kitsuden-email`, agent notifications, rule
webhooks…), and it queues jobs on another kon's queue only when that kon, or
the core, allows it.

## The namespace

A kon's queue names start with one of:

| Form           | Example (`kon-crm`) | Notes                                                                |
| -------------- | ------------------- | -------------------------------------------------------------------- |
| `<short id>:`  | `crm:sync`          | The recommended form.                                                |
| `<kon id>:`    | `kon-crm:sync`      | The form older docs showed; still the kon's own.                     |
| An event alias | `shop:` (ecommerce) | The kons in `KON_EVENT_NAMESPACE_ALIASES` keep their alias here too. |
| A legacy name  | `koe-inbound`       | Only the names in `KON_QUEUE_LEGACY_NAMES` (see below).              |

`core:`, `kitsuden:`, `system:`, `kon:`, `agent:`, `email:`, `mail:` and
`auth:`, and every `kitsuden-*` name, belong to the core.

## Two ways to use it

`ctx.queue` is tied to the kon and needs nothing else:

```ts
hooks: {
  onStartup: async (ctx) => {
    ctx.queue!.handle("sync", async (job) => {
      await syncPartner(job.payload); // must be idempotent
    }, { concurrency: 2 });
  },
},

// In a route or operation:
await ctx.queue!.add("sync", "partner", { partnerId });
```

`queue` from `@kitsuden/engine` works the same way. The core knows which kon is
calling from the kon's scope: while it imports and starts the kon, during each
request to the kon's routes (REST and MCP), and inside the kon's queue handlers,
event handlers, rule steps and schedules.

## A plain name is mapped

A name with no namespace that no one owns (`sync`) is mapped into the kon's
namespace: `handle("sync")` and `add("sync", …)` both use `crm:sync`. A name
already in the namespace is used as is, never prefixed twice. `job.queue` in the
handler is the full name (`crm:sync`), and `ctx.queue.name("sync")` tells you
the full name, for example to tell another kon where to reply.

The old plain name stays registered as an alias of the same handler, so jobs
queued under `sync` before the upgrade still run. Once those jobs are gone,
rename the queue in the code to `crm:sync`. Set `KON_QUEUE_LEGACY_DRAIN=false`
to stop draining old names. The alias then goes away, and jobs left under the
old name wait in the queue panel.

We chose this over adding the prefix silently to every name. A silent prefix
would turn `crm:sync` into `crm:crm:sync`, and it would rewrite names a kon
hands to another kon (`replyQueue`). With mapping, each name means the same
thing everywhere: in the handler, the panel, automation rules and other kons'
payloads. A name outside the namespace is refused, never quietly moved.

## What is refused

`handle` and `add` throw a `KonQueueRefused` error, because a job sent nowhere
is lost work.

- **Handling** is allowed only for the kon's own names that no one else
  handles. A core queue, a queue the core already handles, another kon's
  namespace or legacy name, or a name another kon already mapped is refused.
  Nothing lets one kon handle another kon's queue.
- **Queueing** is allowed on the kon's own names, and on another kon's queue
  when that kon opened it:

  ```ts
  // kon-chat accepts channel turns from any kon:
  ctx.queue!.handle("chat:channel-turns", processTurn, { senders: ["*"] });
  // kon-koe takes replies only from kon-chat:
  ctx.queue!.handle("koe:bot-replies", processReply, { senders: ["kon-chat"] });
  ```

  `senders` lists kon ids, short ids, or `"*"`. Core queues cannot be opened
  this way. A kon reaches the core's queues only through the core's own APIs
  (`ctx.mail`, `defineModel` embeddings) or the core's grant list.

## What the published kons use

The core keeps these working without any change in Kitsuden/kitsuden-kons:

| Kon          | Handles                                                                                                                   | Queues on someone else's                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `kon-koe`    | `koe-inbound`, `koe-outbound`, `koe-media`, `koe-bot`, `koe-bot-replies`, `koe-notify`, `koe-automation` (legacy `koe-*`) | `chat-channel-turns` (kon-chat)                         |
| `kon-chat`   | `chat-channel-turns` (legacy)                                                                                             | `koe-bot-replies`, the `replyQueue` koe names in a turn |
| `kon-ingest` | `kitsuden-ingest` (legacy, though it looks core)                                                                          | `kitsuden-embeddings` (core)                            |

The legacy names are in `KON_QUEUE_LEGACY_NAMES`, and the cross-kon and core
queues in `LEGACY_QUEUE_GRANTS` (`apps/api/src/lib/queue-kon-access.ts`). No
other published kon uses the queue. Follow-ups for those kons, after which the
grants can go:

- kon-chat: open `chat-channel-turns` with `senders: ["*"]`. A kon other than
  koe that wants channel bots must open its reply queue with
  `senders: ["kon-chat"]`, because the grant covers only `koe-bot-replies`.
- kon-koe: open `koe-bot-replies` with `senders: ["kon-chat"]`.
- kon-ingest: queue embeddings through a core API instead of
  `kitsuden-embeddings`, and move to `ingest:documents`. Until then, its jobs
  count as a system queue and are not charged to an agent's budget.
- Any kon: prefer `ctx.queue` over the engine import. It needs no scope.

## Limits

The guard is not a sandbox. A kon is code in the API process and can import the
engine's raw queue file. The guard stops one kon taking over another kon's
queues through the API the core hands it, and makes every refusal visible.

Code a kon runs outside its scope cannot be attributed. This means callbacks the
core calls from somewhere else, such as a content-publishing target or a
realtime authorizer. That code is still kept off the core's queues, and it
cannot take a queue another kon handles. It is not stopped from queueing on
another kon's queue. `ctx.queue` has no such gap.

Handlers registered through `defineAction({ trigger: "event:<name>" })` go
through the core's action registry and are not checked here.
