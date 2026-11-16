# Realtime channels in a kon

A kon pushes live updates to browsers through the core's WebSocket (`/api/realtime`). Dataset
channels (`table:<slug>`, `entry:<id>`) are authorized by the dataset's policy. A kon's own
channels are authorized by the kon.

```ts
// at startup: who may listen to kon:koe:<rest>
ctx.realtime.channels?.(async (rest, user) => {
  if (rest === "inbox") return isMember(user.id);
  const m = /^conversation:(.+)$/.exec(rest);
  if (m) return maySee(user, m[1]);
  return false;
});

// whenever something changes
ctx.realtime.broadcast("kon:koe:conversation:c1", { type: "message", messageId });
ctx.realtime.sendToUser(userId, { type: "assigned", conversationId: "c1" });
```

A browser subscribes with the usual frame:

```json
{ "type": "subscribe", "channel": "kon:koe:conversation:c1" }
```

## Names

```
kon:<kon id without "kon-">:<rest>        kon:koe:inbox      kon:koe:conversation:c1
```

`<rest>` is up to 200 characters of letters, digits and `_ . : -`. Anything else is refused before
any authorizer runs.

## What the host guarantees

|                          |                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Only the kon decides** | A `kon:` channel is denied until its kon registers an authorizer, admins included: nobody but the kon knows what it carries.                           |
| **Its own namespace**    | The context each kon receives is bound to its id: `ctx.realtime.channels` registers `kon:<its short id>:` and nothing else.                            |
| **Asked again**          | The authorizer runs on subscribe and again on every session sweep (every minute). Access the kon revokes stops within it.                              |
| **Fails closed**         | An authorizer that throws, or returns anything but `true`, denies.                                                                                     |
| **Anonymous sockets**    | The authorizer receives `id: null`. A kon may allow them (a visitor holding an unguessable key) or not.                                                |
| **Every replica**        | `broadcast` and `sendToUser` go through the bus (Valkey, or Postgres NOTIFY without it) and reach the sockets of every API process, each exactly once. |

## What to send

Small messages: ids and what changed, never content the client could not read over REST. The
client re-reads through your operations, which apply row-level security; a message that slipped
through after a revocation then carries nothing worth having.

`ctx.realtime.channels` is optional: a host without realtime, or a test, leaves it undefined. Say
so in the log and let the client fall back to polling.
