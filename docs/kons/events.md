# Kon events

A kon tells the rest of the installation that something happened. Another kon, or
an [automation rule](../automation.md) a person wrote, reacts to it. Neither side
imports the other, and each works the same when the other is not installed.

```ts
// kon-ecommerce, when an order is paid
ctx.events.emit("shop:order.paid", { orderId, email, totalCents });

// kon-crm, at startup
ctx.events.on("shop:order.paid", (data) => {
  void ctx.db.background(() => attachOrderToContact(data));
});
```

## Names

```
<source>:<entity>.<what-happened>        crm:deal.won      shop:order.paid
```

- `source` is the kon without its `kon-` prefix.
- `what-happened` is a past participle: an event states a fact, it does not ask
  for anything. `order.paid`, not `order.pay`.
- Lower case letters, digits, and `: . _ -`. The host accepts
  `/^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9:._-]{1,200}$/` (`KON_EVENT_NAME` in
  `@kitsuden/shared`).

Events that already exist keep their names (`crm:deal:stage-changed`,
`payment:subscription.created`). Do not rename an event: every rule that listens
to it stops firing, silently.

The core's own events are listened to under dotted names: `entry.created`,
`entry.updated`, `entry.deleted`, `post.published`.

## Declaring them

Emitting is `ctx.events.emit`. Declaring is what makes the event visible to the
panel, to agents and to whoever writes a rule:

```ts
export default defineKon({
  id: "kon-crm",
  events: {
    emits: {
      "crm:deal.won": {
        description: "A deal was marked as won.",
        payload: { dealId: "uuid of the deal", amount: "number, in cents", ownerId: "user id" },
      },
    },
    listens: ["shop:order.paid", "newsletter:member.subscribed"],
  },
});
```

- `emits`: every event the kon emits, with one sentence and its payload field by
  field. The payload is documentation, not validation.
- `listens`: events of other kons this one reacts to. A name nobody emits is
  fine; the other kon may not be installed.

A malformed declaration is reported in the load log and skipped; the kon still
loads. The catalog of every declared event is served at
`GET /api/automation/catalog` (administrators).

## The payload

- A plain object. A rule's conditions read it by dot path (`deal.amount`), so
  put what a condition will need at a shallow, stable path.
- Ids and facts, not whole rows: a listener that needs more reads it.
- Never a secret, and nothing the listener may not see: a listener runs as the
  system (below).

## What the host guarantees

|                                                       |                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **After commit**                                      | An event emitted inside a request is delivered only once the request's transaction has committed. A request that rolls back emits nothing.                               |
| **In this process**                                   | Delivery is in memory. Other API processes do not hear it.                                                                                                               |
| **At most once**                                      | There is no retry and no durable log. A process that stops between the commit and the delivery loses the event.                                                          |
| **Listeners run as the system**                       | The request's transaction is closed by then, so a listener's queries are not filtered by row policies. A listener that acts on behalf of someone must apply that itself. |
| **A listener that throws does not break the emitter** | Errors are the listener's to report.                                                                                                                                     |

If an event must not be lost, do not rely on it alone: write the fact in your own
table in the same transaction and treat the event as a prompt to look.

For work that must survive a restart, dispatch a job on the transactional queue
(`queue.dispatch`, see [the queue](../install/queue.md)); it is written in the
request's transaction and retried.

## Listening from a kon

```ts
hooks: {
  onStartup: async (ctx) => {
    ctx.events.on("shop:order.paid", (data) => {
      void ctx.db.background(async () => {
        // the system connection; idempotent, because a manual re-run may repeat it
      });
    });
  },
},
```

Keep a listener idempotent, and never let it depend on the emitter being
installed.

## Who may emit

A kon emits only in its own namespace: its id without `kon-` (`kon-crm` emits
`crm:…`). Four kons keep the names they had before this rule: `kon-ecommerce`
emits `shop:`, `kon-payments` emits `payment:`, `kon-datasets` (the core's
datasets module) emits `dataset:` and `entry:`, and `kon-blocks` (the core's
page builder) emits `page:`. Those namespaces belong to them, so a kon named
`kon-shop` does not get `shop:`. No other kon emits in the core's namespaces
(`auth`, `connections`, `dataset`, `entry`, `page`, `post`, and the reserved
`core`, `kitsuden`, `kon`, `system`).

An event outside the kon's namespaces is dropped and logged once; the request
that emitted it does not fail.

## Who may listen

A kon always hears its own events and the core's (the namespaces above, and the
old dotted names with no namespace, such as `entry.created`). Another kon's event
reaches it only when the emitting kon shares it:

```ts
defineKon({
  id: "kon-ecommerce",
  events: {
    emits: { "shop:order.paid": { description: "An order was paid." } },
    // Any kon may hear these.
    public: ["shop:product.published"],
    // Only the kons named here, by id.
    subscribers: {
      "kon-crm": ["shop:order.paid"],
      "kon-dc": ["shop:order.*"],
    },
  },
});
```

The same `events` object may go in `kon.json`; the two are merged. A pattern is
a full name or a prefix ending in `*`, and its namespace is always spelled out
(`*` or `shop*` alone is refused). A pattern outside the emitter's own
namespace has no effect and is reported when the kon loads.

The check runs each time an event is delivered, not only when the listener
subscribes, because the emitting kon may load later or be switched off. A
refused event is not delivered, and the console says once, for each listener
and event, which declaration is missing.

Two built-in lists keep what worked before this rule:

- `DEFAULT_PUBLIC_EVENTS`: `blog:post:published`, which is public content.
- `LEGACY_EVENT_GRANTS`: the cross-kon subscriptions the published kons
  already made (kon-crm, kon-ecommerce, kon-members, kon-newsletter). An entry
  goes once its emitter declares it; new subscriptions belong in the emitter's
  `public` or `subscribers`.

Both lists live in `apps/api/src/lib/kon-event-access.ts`. This is not a
sandbox: a kon is code in the API process. The rule stops one kon reading or
forging another's events through the context the core gives it, and makes a
refusal visible.

## Testing

`createTestKonContext` gives a context whose `events` do nothing. To test what a
kon emits, pass your own `events` and assert on it; to test a rule end to end,
use `dispatchEvent(name, payload)` from the actions engine, as
`apps/api/src/tests/kon-foundations.test.ts` does.
