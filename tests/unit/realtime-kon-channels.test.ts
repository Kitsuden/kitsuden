/**
 * Realtime: channels a kon owns (`kon:<short id>:<rest>`) and `sendToUser` across replicas.
 *
 *   - a kon channel is denied until its kon registers an authorizer, admins included;
 *   - the authorizer receives `<rest>` and the socket's user, anonymous included;
 *   - an authorizer that throws denies; the periodic sweep re-asks it and drops what it revoked;
 *   - a kon's context only registers its OWN namespace;
 *   - once the bus listens, `broadcast` and `sendToUser` go through it and reach this process once.
 *
 * No database or Valkey: the bus is an in-memory double that loops back like Valkey does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BusFn = (channel: string, message: string) => void;
const bus: Array<{ re: RegExp; fn: BusFn }> = [];
const published: string[] = [];

vi.mock("../../apps/api/src/lib/valkey", () => ({
  subscribe: vi.fn(async (pattern: string, fn: BusFn) => {
    bus.push({ re: new RegExp(`^${pattern.replace("*", ".*")}$`), fn });
    return async () => undefined;
  }),
  publish: vi.fn(async (channel: string, message: unknown) => {
    published.push(channel);
    for (const s of bus) if (s.re.test(channel)) s.fn(channel, JSON.stringify(message));
  }),
  getValkeyClient: () => Promise.reject(new Error("no Valkey in this test")),
}));

const state: { session: { userId: string; expiresAt: Date; role: string } | null } = { session: null };

vi.mock("../../apps/api/src/db", () => {
  const select = () => {
    const builder = {
      from: () => builder,
      innerJoin: () => builder,
      where: () => builder,
      limit: async () => (state.session ? [state.session] : []),
    };
    return builder;
  };
  return { db: { select } };
});

const realtime = await import("../../apps/api/src/lib/realtime");
const wiring = await import("../../apps/api/src/lib/realtime-wiring");
const channels = await import("../../apps/api/src/lib/realtime-kon-channels");
const { bindKonContext } = await import("../../apps/api/src/lib/kon-setup");

const { realtimeManager, SESSION_REVALIDATE_MS } = realtime;

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
}

const open: string[] = [];
let next = 0;
function connect(userId: string | null, role: string | null) {
  const id = `ws_kon_${++next}`;
  const socket: FakeSocket = { send: vi.fn(), close: vi.fn(), data: {} };
  realtimeManager.addClient(id, socket as never, userId, role, {
    id: userId ? `s-${userId}` : null,
    expiresAt: userId ? Date.now() + 3_600_000 : null,
  });
  if (userId) state.session = { userId, role: role ?? "user", expiresAt: new Date(Date.now() + 3_600_000) };
  open.push(id);
  return { id, socket };
}

const received = (s: FakeSocket) => s.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
const messages = (s: FakeSocket) => received(s).filter((m) => m.type === "message");
const subscribed = (s: FakeSocket, channel: string) => received(s).some((m) => m.type === "subscribed" && m.channel === channel);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  wiring.wireRealtimeAuthorization();
  channels.unregisterKonChannels("kon-koe");
  channels.unregisterKonChannels("kon-other");
});

afterEach(() => {
  for (const id of open.splice(0)) realtimeManager.removeClient(id);
  realtime.setSessionValidator(null);
  state.session = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("kon channels", () => {
  it("are denied until the kon registers an authorizer, even to an admin", async () => {
    const root = connect("root", "admin");
    await realtimeManager.subscribeToChannel(root.id, "kon:koe:inbox:t1");
    expect(subscribed(root.socket, "kon:koe:inbox:t1")).toBe(false);
  });

  it("the authorizer decides with the channel's rest and the user, anonymous included", async () => {
    const seen: Array<[string, string | null]> = [];
    channels.registerKonChannels("kon-koe", (rest, user) => {
      seen.push([rest, user.id]);
      return rest === `user:${user.id}` || rest === "visitor:abc";
    });
    const ana = connect("ana", "user");
    const anon = connect(null, null);

    await realtimeManager.subscribeToChannel(ana.id, "kon:koe:user:ana");
    await realtimeManager.subscribeToChannel(ana.id, "kon:koe:user:bob");
    await realtimeManager.subscribeToChannel(anon.id, "kon:koe:visitor:abc");

    expect(subscribed(ana.socket, "kon:koe:user:ana")).toBe(true);
    expect(subscribed(ana.socket, "kon:koe:user:bob")).toBe(false);
    expect(subscribed(anon.socket, "kon:koe:visitor:abc")).toBe(true);
    expect(seen).toContainEqual(["visitor:abc", null]);

    realtimeManager.broadcast("kon:koe:user:ana", { hello: 1 });
    await flush();
    expect(messages(ana.socket)).toEqual([{ type: "message", channel: "kon:koe:user:ana", data: { hello: 1 } }]);
  });

  it("an authorizer that throws denies", async () => {
    channels.registerKonChannels("kon-koe", () => {
      throw new Error("boom");
    });
    const ana = connect("ana", "admin");
    await realtimeManager.subscribeToChannel(ana.id, "kon:koe:x");
    expect(subscribed(ana.socket, "kon:koe:x")).toBe(false);
  });

  it("malformed kon channels are refused before any authorizer runs", async () => {
    const authorize = vi.fn(() => true);
    channels.registerKonChannels("kon-koe", authorize);
    const ana = connect("ana", "admin");
    for (const bad of ["kon:koe:", "kon::x", "kon:KOE:x", "kon:koe:a b", "user:ana"]) {
      await realtimeManager.subscribeToChannel(ana.id, bad);
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it("the sweep asks again and drops a channel the kon revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let allowed = true;
    channels.registerKonChannels("kon-koe", () => allowed);
    const ana = connect("ana", "user");
    await realtimeManager.subscribeToChannel(ana.id, "kon:koe:conversation:c1");
    expect(subscribed(ana.socket, "kon:koe:conversation:c1")).toBe(true);

    allowed = false; // reassigned to someone else
    await vi.advanceTimersByTimeAsync(SESSION_REVALIDATE_MS);
    await flush();
    expect(received(ana.socket).some((m) => m.type === "unsubscribed")).toBe(true);

    realtimeManager.broadcast("kon:koe:conversation:c1", { secret: true });
    await flush();
    expect(messages(ana.socket)).toEqual([]);
  });

  it("a kon's bound context registers only its own namespace", async () => {
    const base = {
      realtime: { broadcast: () => {}, sendToUser: () => {} },
    } as never;
    const koe = bindKonContext(base, "kon-koe");
    koe.realtime.channels!((rest) => rest === "ok");
    const ana = connect("ana", "user");
    await realtimeManager.subscribeToChannel(ana.id, "kon:koe:ok");
    await realtimeManager.subscribeToChannel(ana.id, "kon:other:ok");
    expect(subscribed(ana.socket, "kon:koe:ok")).toBe(true);
    expect(subscribed(ana.socket, "kon:other:ok")).toBe(false);
  });
});

describe("through the bus", () => {
  it("broadcast and sendToUser publish once and reach this process once", async () => {
    await realtimeManager.initialize();
    channels.registerKonChannels("kon-koe", () => true);
    const ana = connect("ana", "user");
    await realtimeManager.subscribeToChannel(ana.id, "kon:koe:inbox");

    published.length = 0;
    realtimeManager.broadcast("kon:koe:inbox", { n: 1 });
    realtimeManager.sendToUser("ana", { type: "koe:notice", n: 2 });
    await flush();

    expect(published).toEqual(["kon:koe:inbox", "user:ana"]);
    expect(messages(ana.socket)).toHaveLength(1);
    expect(received(ana.socket).filter((m) => m.type === "koe:notice")).toHaveLength(1);
  });
});
