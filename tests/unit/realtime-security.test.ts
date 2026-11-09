/**
 * Realtime (WebSocket): regressions from the 2026-11-04 security review.
 *
 *   F1  — an anonymous socket is `null` to the gate: `authenticated` denies it,
 *         and a role on a socket without a user is nothing.
 *   F2  — outside the team, only published or own rows (`publishedOrOwn`); the
 *         team reaches every dataset as over REST; `previous` follows the row's rules.
 *   F15/F82 — the session is re-read on subscribe and every minute; the socket
 *         closes when it was revoked, expired or the role changed.
 *   F76 — the row filter honours the policy TTL, an edit invalidates it, and a
 *         query that raced an invalidation is not cached.
 *   F78 — a malformed frame does not throw nor leave an uncaught promise.
 *
 * No database or Valkey: both are replaced by doubles.
 */
import { checkReadAccess, checkWriteAccess, type PolicyJson } from "@kitsuden/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/lib/valkey", () => ({
  subscribe: vi.fn(async () => undefined),
  publish: vi.fn(async () => undefined),
  getValkeyClient: () => Promise.reject(new Error("no Valkey in this test")),
}));

// The "database": the dataset policy and the session being read.
const state: {
  policy: PolicyJson | null;
  datasetExists: boolean;
  policyQueries: number;
  /** While set, a policy query waits for it (the value is read BEFORE waiting). */
  policyGate: Promise<void> | null;
  session: { userId: string; expiresAt: Date; role: string } | null;
  sessionFails: boolean;
} = {
  policy: null,
  datasetExists: true,
  policyQueries: 0,
  policyGate: null,
  session: null,
  sessionFails: false,
};

vi.mock("../../apps/api/src/db", () => {
  const select = (cols: Record<string, unknown>) => {
    const builder = {
      from: () => builder,
      innerJoin: () => builder,
      where: () => builder,
      limit: async () => {
        if ("policyJson" in cols) {
          state.policyQueries++;
          const rows = state.datasetExists ? [{ policyJson: state.policy }] : [];
          if (state.policyGate) await state.policyGate;
          return rows;
        }
        if (state.sessionFails) throw new Error("database down");
        return state.session ? [state.session] : [];
      },
    };
    return builder;
  };
  return { db: { select } };
});

const realtime = await import("../../apps/api/src/lib/realtime");
const wiring = await import("../../apps/api/src/lib/realtime-wiring");
const changes = await import("../../apps/api/src/lib/realtime-changes");
const { events } = await import("../../apps/api/src/lib/events");

const { realtimeManager, decideSession, CLOSE_INVALID_SESSION, SESSION_REVALIDATE_MS } = realtime;
const { filterForClient, canSubscribe } = changes;

// ── Doubles ──────────────────────────────────────────────────────────────────

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
}

const openClients: string[] = [];
let nextId = 0;

function connect(
  userId: string | null,
  role: string | null,
  session: { id: string | null; expiresAt: number | null } = {
    id: userId ? `s-${userId}` : null,
    expiresAt: userId ? Date.now() + 3_600_000 : null,
  }
): { id: string; socket: FakeSocket } {
  const id = `ws_test_${++nextId}`;
  const socket: FakeSocket = { send: vi.fn(), close: vi.fn(), data: {} };
  realtimeManager.addClient(id, socket as never, userId, role, session);
  openClients.push(id);
  return { id, socket };
}

/** Messages a socket received, parsed. */
const received = (s: FakeSocket) =>
  s.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
const rowsReceived = (s: FakeSocket) => received(s).filter((m) => m.type === "message");
const errors = (s: FakeSocket) => received(s).filter((m) => m.type === "error");
const subscribed = (s: FakeSocket) => received(s).some((m) => m.type === "subscribed");

/** Lets pending promises and callbacks run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const sessionFor = (userId: string, role: string, ms = 3_600_000) => ({
  userId,
  role,
  expiresAt: new Date(Date.now() + ms),
});

/** The same session as the realtime validator returns it (expiry in ms). */
const currentFor = (userId: string, role: string) => ({
  ...sessionFor(userId, role),
  expiresAt: sessionFor(userId, role).expiresAt.getTime(),
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  dataSetId: "ds-1",
  status: "draft",
  ownerId: "bob",
  createdById: "bob",
  data: { title: "Bob's draft" },
  ...over,
});

const event = (r: Record<string, unknown>, previous?: Record<string, unknown>) => ({
  type: previous ? "UPDATE" : "INSERT",
  resource: "news",
  row: r,
  ...(previous ? { previous } : {}),
  at: "2026-11-04T00:00:00.000Z",
});

const CHANNEL = "table:news";

beforeEach(() => {
  state.policy = { readAccess: "public" } as PolicyJson;
  state.datasetExists = true;
  state.policyQueries = 0;
  state.policyGate = null;
  state.session = null;
  state.sessionFails = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  wiring.wireRealtimeAuthorization();
  wiring.invalidateRealtimePolicy();
});

afterEach(() => {
  for (const id of openClients.splice(0)) realtimeManager.removeClient(id);
  realtime.setSessionValidator(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── F1 ───────────────────────────────────────────────────────────────────────

describe("F1: an anonymous socket does not pass `readAccess: authenticated`", () => {
  it("checkReadAccess and checkWriteAccess need an id, not just any object", () => {
    const policy = { readAccess: "authenticated", writeAccess: "authenticated" } as PolicyJson;
    expect(checkReadAccess(policy, null)).toBe(false);
    expect(checkReadAccess(policy, { id: undefined } as never)).toBe(false);
    expect(checkReadAccess(policy, { id: "alice", role: "user" })).toBe(true);
    expect(checkWriteAccess(policy, { id: undefined } as never)).toBe(false);
    expect(checkWriteAccess(policy, { id: "alice", role: "user" })).toBe(true);
  });

  it("the wiring passes `null` for an anonymous socket", () => {
    expect(wiring.policyUser({ id: null, role: null })).toBeNull();
    expect(wiring.policyUser({ id: null, role: "admin" })).toBeNull();
    expect(wiring.policyUser({ id: "alice", role: "user" })).toEqual({ id: "alice", role: "user" });
  });

  it("an anonymous socket does not subscribe to an `authenticated` dataset", async () => {
    state.policy = { readAccess: "authenticated" } as PolicyJson;
    const anon = connect(null, null);
    await realtimeManager.subscribeToChannel(anon.id, CHANNEL);
    expect(subscribed(anon.socket)).toBe(false);
    expect(errors(anon.socket)[0]?.message).toMatch(/Not authorized/);

    const alice = connect("alice", "user");
    state.session = sessionFor("alice", "user");
    await realtimeManager.subscribeToChannel(alice.id, CHANNEL);
    expect(subscribed(alice.socket)).toBe(true);
  });

  it("a role on a socket without a user opens nothing", async () => {
    const ghost = connect(null, "admin");
    await realtimeManager.subscribeToChannel(ghost.id, "entry:row-1");
    expect(subscribed(ghost.socket)).toBe(false);
    expect(canSubscribe(CHANNEL, null, null)).toBe(false);
  });

  it("the row filter does not deliver to an anonymous socket under `authenticated`", () => {
    const policy = { policyJson: { readAccess: "authenticated" } as PolicyJson };
    const published = event(row({ status: "published" })) as never;
    expect(
      filterForClient(published, wiring.policyUser({ id: null, role: null }), policy)
    ).toBeNull();
  });
});

// ── F2 ───────────────────────────────────────────────────────────────────────

describe("F2: other people's drafts stay off the socket (publishedOrOwn)", () => {
  const open = { policyJson: { readAccess: "public" } as PolicyJson };
  const alice = { id: "alice", role: "user" };

  it("someone else's draft is not delivered; a published row is", () => {
    expect(filterForClient(event(row()) as never, alice, open)).toBeNull();
    expect(filterForClient(event(row()) as never, null, open)).toBeNull();
    expect(
      filterForClient(event(row({ status: "published" })) as never, alice, open)
    ).not.toBeNull();
    expect(
      filterForClient(event(row({ status: "published" })) as never, null, open)
    ).not.toBeNull();
  });

  it("an own draft arrives, by owner or by creator", () => {
    expect(filterForClient(event(row({ ownerId: "alice" })) as never, alice, open)).not.toBeNull();
    expect(
      filterForClient(event(row({ createdById: "alice" })) as never, alice, open)
    ).not.toBeNull();
  });

  it("the team (admin and editor) sees drafts and reaches every dataset, as over REST", () => {
    for (const role of ["admin", "editor"]) {
      expect(filterForClient(event(row()) as never, { id: "staff", role }, open)).not.toBeNull();
    }
    // an editor subscribes to an admin-only dataset and gets its rows, as it reads it over REST
    const adminOnly = { policyJson: { readAccess: "admin" } as PolicyJson };
    const editor = { id: "ed", role: "editor" };
    expect(canSubscribe(CHANNEL, editor, adminOnly)).toBe(true);
    expect(filterForClient(event(row()) as never, editor, adminOnly)).not.toBeNull();
    expect(canSubscribe(CHANNEL, alice, adminOnly)).toBe(false);
    expect(
      filterForClient(event(row({ status: "published" })) as never, alice, adminOnly)
    ).toBeNull();
  });

  it("an editor still meets the dataset's rlsRules (only admin skips them, as in buildDatasetWhere)", () => {
    const byOwner = {
      policyJson: {
        readAccess: "authenticated",
        rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
      } as PolicyJson,
    };
    const editor = { id: "ed", role: "editor" };
    expect(
      filterForClient(event(row({ status: "published" })) as never, editor, byOwner)
    ).toBeNull();
    expect(filterForClient(event(row({ ownerId: "ed" })) as never, editor, byOwner)).not.toBeNull();
    expect(
      filterForClient(
        event(row({ status: "published" })) as never,
        { id: "a", role: "admin" },
        byOwner
      )
    ).not.toBeNull();
  });

  it("on publish, the previous version (someone else's draft) does not travel in the event", () => {
    const e = event(row({ status: "published" }), row()) as never;
    const delivered = filterForClient(e, alice, open);
    expect(delivered).not.toBeNull();
    expect(delivered).not.toHaveProperty("previous");
  });

  it("a previous version that another owner's rule hides does not travel either", () => {
    const byOwner = {
      policyJson: {
        readAccess: "authenticated",
        rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
      } as PolicyJson,
    };
    // Bob's published row handed over to Alice: she sees the row, not Bob's version.
    const e = event(
      row({ status: "published", ownerId: "alice" }),
      row({ status: "published", data: { title: "Bob's notes" } })
    ) as never;
    const delivered = filterForClient(e, alice, byOwner);
    expect(delivered).not.toBeNull();
    expect(delivered).not.toHaveProperty("previous");
    expect(JSON.stringify(delivered)).not.toContain("Bob's notes");
  });

  it("an event without a row object is not delivered to a non-admin", () => {
    const broken = { type: "INSERT", resource: "news", row: null, at: "x" } as never;
    expect(filterForClient(broken, alice, open)).toBeNull();
  });

  it("end to end: a subscriber does not receive someone else's draft", async () => {
    const alice = connect("alice", "user");
    state.session = sessionFor("alice", "user");
    await realtimeManager.subscribeToChannel(alice.id, CHANNEL);

    realtimeManager.broadcast(CHANNEL, event(row()));
    realtimeManager.broadcast(CHANNEL, event(row({ id: "row-2", status: "published" })));
    await flush();

    const rows = rowsReceived(alice.socket);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.data as { row: { id: string } }).row.id).toBe("row-2");
  });
});

// ── F76 ──────────────────────────────────────────────────────────────────────

describe("F76: the filter's policy expires and is invalidated", () => {
  async function aliceSubscribed() {
    const alice = connect("alice", "user");
    state.session = sessionFor("alice", "user");
    await realtimeManager.subscribeToChannel(alice.id, CHANNEL);
    expect(subscribed(alice.socket)).toBe(true);
    return alice;
  }
  const published = () => event(row({ status: "published" }));

  it("past the TTL, delivery re-reads the policy and stops delivering", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const alice = await aliceSubscribed();

    realtimeManager.broadcast(CHANNEL, published());
    await flush();
    expect(rowsReceived(alice.socket)).toHaveLength(1);

    // The dataset is restricted; no invalidation, only time passes.
    state.policy = { readAccess: "admin" } as PolicyJson;
    vi.setSystemTime(Date.now() + wiring.POLICY_TTL_MS + 1);
    const before = state.policyQueries;

    realtimeManager.broadcast(CHANNEL, published());
    await flush();
    expect(state.policyQueries).toBe(before + 1);
    expect(rowsReceived(alice.socket)).toHaveLength(1); // nothing new
  });

  it("editing the dataset invalidates the policy at once, without waiting for the TTL", async () => {
    const alice = await aliceSubscribed();
    state.policy = { readAccess: "admin" } as PolicyJson;
    events.emit("dataset:updated", { id: "ds-1", slug: "news" });

    realtimeManager.broadcast(CHANNEL, published());
    await flush();
    expect(rowsReceived(alice.socket)).toHaveLength(0);
  });

  it("deleting the dataset invalidates it too", async () => {
    const alice = await aliceSubscribed();
    state.datasetExists = false;
    events.emit("dataset:deleted", { id: "ds-1" });

    realtimeManager.broadcast(CHANNEL, published());
    await flush();
    expect(rowsReceived(alice.socket)).toHaveLength(0);
  });

  it("a query that raced an invalidation is returned but not cached", async () => {
    const alice = connect("alice", "user");
    state.session = sessionFor("alice", "user");
    let release!: () => void;
    state.policyGate = new Promise<void>((r) => (release = r));

    // The subscribe's query reads the OLD policy and is still in flight...
    const subscribing = realtimeManager.subscribeToChannel(alice.id, CHANNEL);
    await flush();
    expect(state.policyQueries).toBe(1);
    // ...when the dataset is restricted and the cache invalidated.
    state.policy = { readAccess: "admin" } as PolicyJson;
    wiring.invalidateRealtimePolicy("news");
    state.policyGate = null;
    release();
    await subscribing;

    // The next delivery does not trust the stale read: it queries again.
    realtimeManager.broadcast(CHANNEL, published());
    await flush();
    expect(state.policyQueries).toBe(2);
    expect(rowsReceived(alice.socket)).toHaveLength(0);
  });

  it("concurrent subscribers share one policy query", async () => {
    const alice = connect("alice", "user");
    const bob = connect("bob", "user");
    realtime.setSessionValidator(async (id) =>
      id === "s-alice" ? currentFor("alice", "user") : currentFor("bob", "user")
    );
    await Promise.all([
      realtimeManager.subscribeToChannel(alice.id, CHANNEL),
      realtimeManager.subscribeToChannel(bob.id, CHANNEL),
    ]);
    expect(subscribed(alice.socket) && subscribed(bob.socket)).toBe(true);
    expect(state.policyQueries).toBe(1);
  });
});

// ── F78 ──────────────────────────────────────────────────────────────────────

describe("F78: malformed frames", () => {
  it("do not throw and answer with an error", async () => {
    const anon = connect(null, null);
    const frames = [
      "null",
      "123",
      '"text"',
      "[]",
      "{not json",
      "{}",
      '{"type":5}',
      '{"type":"subscribe","channel":123}',
      '{"type":"subscribe","channel":null}',
      '{"type":"subscribe","channel":{"x":1}}',
      '{"type":"unsubscribe","channel":[]}',
      '{"type":"presence:join","room":1}',
      '{"type":"presence:leave","room":true}',
      JSON.stringify({ type: "subscribe", channel: `table:${"a".repeat(10_000)}` }),
      JSON.stringify({ type: "x".repeat(10_000) }),
    ];
    for (const f of frames) {
      expect(() => realtimeManager.handleMessage(anon.id, f), f).not.toThrow();
    }
    await flush();
    expect(errors(anon.socket)).toHaveLength(frames.length);
    // The error message does not echo what the client sent.
    for (const e of errors(anon.socket)) expect(String(e.message).length).toBeLessThan(100);
  });

  it("an authorizer that fails leaves no unhandled rejected promise", async () => {
    realtime.setSubscriptionAuthorizer(() => Promise.reject(new Error("boom")));
    try {
      const alice = connect("alice", "user");
      state.session = sessionFor("alice", "user");
      realtimeManager.handleMessage(
        alice.id,
        JSON.stringify({ type: "subscribe", channel: CHANNEL })
      );
      await flush();
      expect(errors(alice.socket).map((e) => e.message)).toContain("Subscription failed");
    } finally {
      wiring.wireRealtimeAuthorization();
    }
  });

  it("a row filter that throws synchronously does not cut off the other subscribers", async () => {
    const alice = connect("alice", "user");
    const bob = connect("bob", "user");
    realtime.setSessionValidator(async (id) =>
      id === "s-alice" ? currentFor("alice", "user") : currentFor("bob", "user")
    );
    await realtimeManager.subscribeToChannel(bob.id, CHANNEL);
    await realtimeManager.subscribeToChannel(alice.id, CHANNEL);
    realtime.setRowFilter((_channel, data, user) => {
      if (user.id === "bob") throw new Error("boom");
      return data;
    });
    try {
      realtimeManager.broadcast(CHANNEL, event(row({ status: "published" })));
      await flush();
      expect(rowsReceived(bob.socket)).toHaveLength(0);
      expect(rowsReceived(alice.socket)).toHaveLength(1);
    } finally {
      wiring.wireRealtimeAuthorization();
    }
  });
});

// ── F15 / F82 ────────────────────────────────────────────────────────────────

describe("F15/F82: revalidating the socket's session", () => {
  const now = 1_800_000_000_000;
  const adminSocket = { userId: "ana", userRole: "admin", sessionId: "s-ana" };

  describe("decideSession (pure)", () => {
    it("keeps a live session with the same role and stores its expiry", () => {
      expect(
        decideSession(adminSocket, { userId: "ana", role: "admin", expiresAt: now + 1 }, now)
      ).toEqual({
        keep: true,
        expiresAt: now + 1,
      });
    });

    it("closes when revoked, expired, the role changed or the user changed", () => {
      const reason = (current: Parameters<typeof decideSession>[1]) => {
        const d = decideSession(adminSocket, current, now);
        return d.keep ? "keep" : d.reason;
      };
      expect(reason(null)).toBe("revoked");
      expect(reason({ userId: "ana", role: "admin", expiresAt: now })).toBe("expired");
      expect(reason({ userId: "ana", role: "user", expiresAt: now + 1 })).toBe("role-changed");
      expect(reason({ userId: "other", role: "admin", expiresAt: now + 1 })).toBe("other-user");
    });

    it("an anonymous socket has nothing to revalidate; a user without a session closes", () => {
      expect(decideSession({ userId: null, userRole: null, sessionId: null }, null, now).keep).toBe(
        true
      );
      expect(decideSession({ ...adminSocket, sessionId: null }, null, now).keep).toBe(false);
    });
  });

  it("a demoted admin is closed on subscribe, before subscribing", async () => {
    const ana = connect("ana", "admin");
    state.session = sessionFor("ana", "user");
    await realtimeManager.subscribeToChannel(ana.id, "entry:row-1");
    expect(subscribed(ana.socket)).toBe(false);
    expect(ana.socket.close).toHaveBeenCalledWith(CLOSE_INVALID_SESSION, expect.any(String));
    expect(realtimeManager.getStats().connections).toBe(0);
  });

  it("the periodic sweep closes a socket whose session was revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ana = connect("ana", "admin");
    const anon = connect(null, null);
    state.session = sessionFor("ana", "admin");

    await vi.advanceTimersByTimeAsync(SESSION_REVALIDATE_MS);
    await flush();
    expect(ana.socket.close).not.toHaveBeenCalled();

    state.session = null; // sign-out / revocation / a demotion that deletes sessions
    await vi.advanceTimersByTimeAsync(SESSION_REVALIDATE_MS);
    await flush();
    expect(ana.socket.close).toHaveBeenCalledWith(CLOSE_INVALID_SESSION, expect.any(String));
    expect(anon.socket.close).not.toHaveBeenCalled(); // the anonymous one stays

    // With no clients, the timer stops.
    realtimeManager.removeClient(anon.id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("when the session cannot be checked, the socket closes (fails closed)", async () => {
    const ana = connect("ana", "admin");
    state.sessionFails = true;
    expect(await realtimeManager.revalidateClient(ana.id)).toBe(false);
    expect(ana.socket.close).toHaveBeenCalled();
  });

  it("a session that expires between sweeps receives no more events", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const alice = connect("alice", "user", { id: "s-alice", expiresAt: Date.now() + 1_000 });
    state.session = sessionFor("alice", "user", 1_000);
    await realtimeManager.subscribeToChannel(alice.id, CHANNEL);
    expect(subscribed(alice.socket)).toBe(true);

    vi.setSystemTime(Date.now() + 2_000);
    realtimeManager.broadcast(CHANNEL, event(row({ status: "published" })));
    await flush();
    expect(rowsReceived(alice.socket)).toHaveLength(0);
    expect(alice.socket.close).toHaveBeenCalledWith(CLOSE_INVALID_SESSION, expect.any(String));
  });
});
