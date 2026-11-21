/**
 * Realtime and kons (2026-11-20).
 *
 *   - H16: `emitChange` stringified the event and `publish` stringified it
 *     again, so subscribers got a JSON string that the row filter could not
 *     read: no table change ever reached a non-admin. It publishes the object.
 *   - H18: a kon disabled from the panel kept authorizing its `kon:` channels
 *     until the restart, and a second kon with the same short id took over the
 *     first one's namespace. A switched-off kon now authorizes nothing, and a
 *     second registration of the namespace throws.
 *   - H19: `ctx.realtime.broadcast` took any channel: a kon could forge
 *     `table:` change events or speak on another kon's channels. It now takes
 *     the kon's own `kon:<short>:` channels and its older `<short>:` ones.
 *
 * No database or Valkey: the bus is an in-memory double that loops back like Valkey does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BusFn = (channel: string, message: string) => void;
const bus: Array<{ re: RegExp; fn: BusFn }> = [];
const published: Array<{ channel: string; message: unknown }> = [];

vi.mock("../../apps/api/src/lib/valkey", () => ({
  subscribe: vi.fn(async (pattern: string, fn: BusFn) => {
    bus.push({ re: new RegExp(`^${pattern.replace("*", ".*")}$`), fn });
    return async () => undefined;
  }),
  publish: vi.fn(async (channel: string, message: unknown) => {
    published.push({ channel, message });
    for (const s of bus) if (s.re.test(channel)) s.fn(channel, JSON.stringify(message));
  }),
  getValkeyClient: () => Promise.reject(new Error("no Valkey in this test")),
}));

const state: { session: { userId: string; expiresAt: Date; role: string } | null } = {
  session: null,
};

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
const activation = await import("../../apps/api/src/lib/kon-activation");
const changes = await import("../../apps/api/src/lib/realtime-changes");
const { bindKonContext } = await import("../../apps/api/src/lib/kon-setup");

const { realtimeManager } = realtime;

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
}

const open: string[] = [];
let next = 0;
function connect(userId: string, role: string) {
  const id = `ws_h18_${++next}`;
  const socket: FakeSocket = { send: vi.fn(), close: vi.fn(), data: {} };
  realtimeManager.addClient(id, socket as never, userId, role, {
    id: `s-${userId}`,
    expiresAt: Date.now() + 3_600_000,
  });
  state.session = { userId, role, expiresAt: new Date(Date.now() + 3_600_000) };
  open.push(id);
  return { id, socket };
}

const subscribed = (s: FakeSocket, channel: string) =>
  s.send.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .some((m) => m.type === "subscribed" && m.channel === channel);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  wiring.wireRealtimeAuthorization();
  channels.unregisterKonChannels("kon-koe");
  activation.resetKonActivationForTests(async () => []);
  published.length = 0;
});

afterEach(() => {
  for (const id of open.splice(0)) realtimeManager.removeClient(id);
  realtime.setSessionValidator(null);
  activation.resetKonActivationForTests();
  state.session = null;
  vi.restoreAllMocks();
});

describe("H16: table changes are published once encoded", () => {
  it("emitChange hands publish the event object, which subscribers read back as an object", async () => {
    await changes.emitChange("INSERT", "abc123", { id: "r1", title: "hi" });
    expect(published).toHaveLength(1);
    const { channel, message } = published[0]!;
    expect(channel).toBe(changes.channelFor("abc123"));
    expect(typeof message).toBe("object");
    const onTheWire = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
    expect(onTheWire).toMatchObject({ type: "INSERT", resource: "abc123", row: { id: "r1" } });
  });
});

describe("H18: kon channels follow the kon's activation", () => {
  it("a kon switched off since startup authorizes nothing, admins included", async () => {
    let enabled = true;
    activation.resetKonActivationForTests(async () => [{ key: "kon-koe", enabled }]);
    activation.trackStartupKon("kon-koe", true);
    channels.registerKonChannels("kon-koe", () => true);

    const on = connect("ana", "admin");
    await realtimeManager.subscribeToChannel(on.id, "kon:koe:inbox");
    expect(subscribed(on.socket, "kon:koe:inbox")).toBe(true);

    enabled = false;
    activation.invalidateKonActivation();
    const off = connect("bob", "admin");
    await realtimeManager.subscribeToChannel(off.id, "kon:koe:inbox");
    expect(subscribed(off.socket, "kon:koe:inbox")).toBe(false);
  });

  it("a second loaded kon with the same short id cannot take over the namespace", () => {
    const base = { realtime: { broadcast: () => {}, sendToUser: () => {} } } as never;
    const first = bindKonContext(base, "kon-koe");
    const second = bindKonContext(base, "koe");
    first.realtime.channels!(() => true);
    // The same kon registering again (a restart of its onStartup) replaces its authorizer.
    expect(() => first.realtime.channels!(() => true)).not.toThrow();
    expect(() => second.realtime.channels!(() => true)).toThrow(/already holds/);
  });
});

describe("H19: a kon broadcasts only on its own channels", () => {
  function ctx(konId: string) {
    const broadcast = vi.fn();
    const bound = bindKonContext({ realtime: { broadcast, sendToUser: () => {} } } as never, konId);
    return { bound, broadcast };
  }

  it("lets through kon:<short>: and the older <short>: channels", () => {
    const { bound, broadcast } = ctx("kon-koe");
    bound.realtime.broadcast("kon:koe:inbox", 1);
    const blog = ctx("kon-blog");
    blog.bound.realtime.broadcast("blog:post:p1", 2);
    expect(broadcast).toHaveBeenCalledWith("kon:koe:inbox", 1);
    expect(blog.broadcast).toHaveBeenCalledWith("blog:post:p1", 2);
  });

  it("drops the core's channels and other kons' channels", () => {
    const { bound, broadcast } = ctx("kon-evil");
    for (const channel of [
      "table:abc123",
      "entry:abc",
      "content:x",
      "user:ana",
      "kon:koe:inbox",
      "koe:x",
      "kon:evil:",
      "evil",
    ]) {
      bound.realtime.broadcast(channel, { forged: true });
    }
    expect(broadcast).not.toHaveBeenCalled();
    expect(channels.konMayBroadcast("kon-evil", "kon:evil:ok")).toBe(true);
    expect(channels.konMayBroadcast("kon-table", "table:abc")).toBe(false);
    expect(channels.konMayBroadcast("kon-user", "user:ana")).toBe(false);
  });
});
