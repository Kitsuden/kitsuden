/**
 * Security audit 2026-11-19: OAuth callbacks belong to their starter; capability channels are keyed
 * ============================================================================
 *
 *   - Connections: the public callback accepted any browser's consent for a state another person started,
 *     so someone could send their consent link to a victim and keep the victim's account in a connection of
 *     their own. `completeOAuth` now requires the starter's browser (binding cookie) or the starter's session,
 *     before any token is exchanged.
 *   - Realtime: a kon channel authorized to whoever names it was as private as its name, and kon-koe used a
 *     value staff can read. `ctx.realtime.capability(material)` gives a name keyed by the server secret.
 *
 * No database: `completeOAuth` gets a fake `db` whose state row is the one the test wrote.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const service = await import("../../apps/api/src/lib/connections/service");
const channels = await import("../../apps/api/src/lib/realtime-kon-channels");

const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";

function fakeDb(pending: Record<string, unknown> | null) {
  return {
    delete: () => ({ where: () => ({ returning: async () => (pending ? [pending] : []) }) }),
    select: () => {
      throw new Error("not reached in these tests");
    },
  };
}

const secrets = {
  seal: (_k: string, p: string) => ({ v: 1, p }) as never,
  open: vi.fn(async () => "the-verifier"),
};

const envBefore = { ...process.env };
beforeAll(() => {
  process.env.CONNECTIONS_GOOGLE_CLIENT_ID = "client-id.apps.example";
  process.env.CONNECTIONS_GOOGLE_CLIENT_SECRET = "client-secret-value";
  process.env.KITSUDEN_SECRETS_KEY = "audit-2026-11-19-test-key-0123456789abcdef";
});
afterAll(() => {
  process.env = envBefore;
});

function pendingFor(state: string, startedBy: string) {
  void state;
  return {
    stateHash: "ignored-by-the-fake",
    provider: "google",
    scope: "user",
    ownerId: startedBy,
    userId: startedBy,
    requestedScopes: [],
    verifier: { v: 1 },
    returnTo: null,
    label: "",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

async function complete(
  state: string,
  completedBy: { userId: string | null; browserBinding: string | null }
) {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ error: "stop_here" }), { status: 400 })
  );
  const run = service.completeOAuth(fakeDb(pendingFor(state, ANA)), secrets, {
    state,
    code: "the-code",
    redirectUri: "https://api.example/api/connections/oauth/callback",
    fetch,
    completedBy,
  });
  return { run, fetch };
}

describe("connections OAuth callback is bound to its starter", () => {
  const state = "state-value-0123456789abcdefghijklmnopqrstuv";

  it("refuses a callback with no session and no binding cookie, before any token exchange", async () => {
    const { run, fetch } = await complete(state, { userId: null, browserBinding: null });
    await expect(run).rejects.toMatchObject({ status: 403, code: "CALLBACK_NOT_BOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses another person's session", async () => {
    const { run, fetch } = await complete(state, { userId: BETO, browserBinding: null });
    await expect(run).rejects.toMatchObject({ status: 403, code: "CALLBACK_NOT_BOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a binding cookie of another round trip", async () => {
    const { run } = await complete(state, {
      userId: null,
      browserBinding: service.browserBindingOf("another-state"),
    });
    await expect(run).rejects.toMatchObject({ code: "CALLBACK_NOT_BOUND" });
  });

  it("lets the starter's browser (binding cookie) or the starter's session through", async () => {
    for (const by of [
      { userId: null, browserBinding: service.browserBindingOf(state) },
      { userId: ANA, browserBinding: null },
    ]) {
      const { run, fetch } = await complete(state, by);
      // Past the binding: it reaches the token exchange, which the double refuses.
      await expect(run).rejects.toMatchObject({ code: "TOKEN_EXCHANGE_FAILED" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("startOAuth hands back the binding for the cookie, not inside the URL", async () => {
    const db = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async () => undefined }),
    };
    const r = await service.startOAuth(db, secrets, {
      provider: "google",
      scope: "user",
      userId: ANA,
      scopeSets: [],
      redirectUri: "https://api.example/api/connections/oauth/callback",
    });
    const url = new URL(r.url);
    expect(r.browserBinding).toBe(service.browserBindingOf(url.searchParams.get("state")!));
    expect(r.url).not.toContain(r.browserBinding);
  });
});

describe("realtime capability channels", () => {
  it("are keyed by the server secret and the kon, and fit a kon channel", () => {
    const hash = "a".repeat(64);
    const cap = channels.konCapability("kon-koe", hash);
    expect(cap).toMatch(/^[0-9a-f]{64}$/);
    expect(cap).not.toBe(hash);
    expect(channels.konCapability("koe", hash)).toBe(cap);
    expect(channels.konCapability("kon-other", hash)).not.toBe(cap);
    expect(channels.isKonChannel(`kon:koe:visitor:${cap}`)).toBe(true);
    const otherServer = channels.konCapability("kon-koe", hash, {
      KITSUDEN_SECRETS_KEY: "a-different-installation-key-0123456789",
    } as NodeJS.ProcessEnv);
    expect(otherServer).not.toBe(cap);
  });

  it("refuse to work without a secrets key or a material", () => {
    expect(() => channels.konCapability("kon-koe", "x", {} as NodeJS.ProcessEnv)).toThrow();
    expect(() => channels.konCapability("kon-koe", "")).toThrow();
  });

  it("are offered through a kon's context, bound to its own id", async () => {
    const { bindKonContext } = await import("../../apps/api/src/lib/kon-setup");
    const base = { realtime: { broadcast: () => undefined, sendToUser: () => undefined } } as never;
    const ctx = bindKonContext(base, "kon-koe");
    expect(ctx.realtime.capability?.("m")).toBe(channels.konCapability("kon-koe", "m"));
    expect(bindKonContext(base, "kon-x").realtime.capability?.("m")).not.toBe(
      channels.konCapability("kon-koe", "m")
    );
  });
});
