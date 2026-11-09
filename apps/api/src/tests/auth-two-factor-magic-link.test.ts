/**
 * Two-factor sign-in (TOTP + backup codes) and magic links, end to end
 * ============================================================================
 *
 * Against the real test database and the real app (lib/auth.ts, migration 0072):
 *
 *   · enrol TOTP, confirm it, then a password sign-in asks for the code and only
 *     the right code (or a backup code, once) opens a session;
 *   · the secret is stored encrypted, not as the authenticator sees it;
 *   · a magic link signs in once, lands on the panel, and an account with
 *     two-factor gets no link (and an old link no longer opens a session);
 *   · `KITSUDEN_ADMIN_MFA=required` stops an admin without a second factor.
 *
 * The emails are read from the queue table (`kitsuden_outbox`): `emailQueue.add`
 * stores the job with its payload there whatever the mail driver is.
 */

import { createHmac } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { authTwoFactors, authUsers } from "../db/schema";
import { app } from "../index";

import { isDatabaseAvailable, enterAs, generateTestId, sessionCookie, testIp } from "./setup";

let dbAvailable = false;

const PASSWORD = "TestPassword123!";
const suffix = generateTestId();
const adminEmail = `test-2fa-admin-${suffix}@example.com`;
const magicEmail = `test-magic-${suffix}@example.com`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  headers.set("X-Forwarded-For", testIp());
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return Promise.resolve(
    app.request(req(path, { method: "POST", body: JSON.stringify(body) }, cookie))
  );
}

/** Every `name=value` the response sets, without attributes. */
function setCookies(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!.trim());
}

function cookieNamed(res: Response, part: string): string | undefined {
  return setCookies(res).find((c) => c.split("=")[0]!.includes(part) && !c.endsWith("="));
}

/** RFC 4648 base32 → bytes (what the otpauth URI carries). */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`bad base32 character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s: what any authenticator app computes. */
function totp(secret: Buffer, offsetSteps = 0): string {
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    (((mac[offset]! & 0x7f) << 24) |
      (mac[offset + 1]! << 16) |
      (mac[offset + 2]! << 8) |
      mac[offset + 3]!) %
    1_000_000;
  return String(code).padStart(6, "0");
}

/** A code that is certainly wrong now (not in the ±1 step window). */
function wrongCode(secret: Buffer): string {
  const valid = new Set([totp(secret, -1), totp(secret), totp(secret, 1)]);
  for (let n = 0; n < 1_000_000; n++) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

/** The payloads of the magic-link emails queued for an address, newest first. */
async function magicLinkEmails(to: string): Promise<Array<{ url: string; expiresIn?: number }>> {
  const result = await db.execute(sql`
    SELECT payload FROM kitsuden_outbox
    WHERE name = 'system.magic-link' AND payload->>'to' = ${to}
    ORDER BY created_at DESC
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    payload: { url: string; expiresIn?: number };
  }>;
  return rows.map((r) => r.payload);
}

/** The link's path and query, to replay it against the app. */
function pathOf(link: string): string {
  const u = new URL(link);
  return `${u.pathname}${u.search}`;
}

async function cleanUp() {
  await db.execute(sql`
    DELETE FROM kitsuden_outbox
    WHERE name = 'system.magic-link' AND payload->>'to' IN (${adminEmail}, ${magicEmail})
  `);
  await db.execute(sql`DELETE FROM auth_users WHERE email IN (${adminEmail}, ${magicEmail})`);
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("two-factor sign-in and magic links", () => {
  let cookie = "";
  let userId = "";
  let secret: Buffer = Buffer.alloc(0);
  let backupCodes: string[] = [];
  let linkBeforeEnrolment = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    await cleanUp();
    const entered = await enterAs(app, {
      email: adminEmail,
      password: PASSWORD,
      name: "2FA Admin",
      role: "admin",
    });
    cookie = entered.cookie;
    userId = entered.userId;
  });

  afterAll(async () => {
    delete process.env.KITSUDEN_ADMIN_MFA;
    if (dbAvailable) await cleanUp();
  });

  it("a magic link requested before enrolling is queued (used later)", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/sign-in/magic-link", { email: adminEmail, callbackURL: "/" });
    expect(res.status).toBe(200);
    const [email] = await magicLinkEmails(adminEmail);
    expect(email?.url).toContain("/api/auth/magic-link/verify");
    linkBeforeEnrolment = email!.url;
  });

  it("KITSUDEN_ADMIN_MFA=required stops an admin without a second factor", async () => {
    if (!dbAvailable) return;
    process.env.KITSUDEN_ADMIN_MFA = "required";
    try {
      const blocked = await app.request(req("/api/settings", {}, cookie));
      expect(blocked.status).toBe(403);
      const body = (await blocked.json()) as { reason?: string; code?: string };
      expect(body.reason).toBe("MFA_REQUIRED");
      expect(body.code).toBe("KITSUDEN_E_FORBIDDEN");

      // better-auth itself stays reachable: that is where the admin enrols.
      const session = await app.request(req("/api/auth/get-session", {}, cookie));
      expect(session.status).toBe(200);
    } finally {
      delete process.env.KITSUDEN_ADMIN_MFA;
    }
  });

  it("enrols TOTP: the secret comes back once, stored encrypted and unconfirmed", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/two-factor/enable", { password: PASSWORD }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totpURI: string; backupCodes: string[] };
    expect(body.totpURI.startsWith("otpauth://totp/")).toBe(true);
    expect(body.backupCodes.length).toBeGreaterThanOrEqual(8);
    backupCodes = body.backupCodes;

    const encoded = new URL(body.totpURI).searchParams.get("secret")!;
    secret = base32Decode(encoded);

    const [row] = await db.select().from(authTwoFactors).where(eq(authTwoFactors.userId, userId));
    expect(row).toBeDefined();
    expect(row!.verified).toBe(false);
    expect(row!.secret).not.toContain(secret.toString("utf8"));
    expect(row!.backupCodes).not.toContain(backupCodes[0]!);

    // Not enabled until a code confirms it.
    const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    expect(user!.twoFactorEnabled).toBe(false);
  });

  it("enabling needs the password", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/two-factor/enable", { password: "wrong-password" }, cookie);
    expect(res.status).toBe(400);
  });

  it("a wrong code does not confirm the enrolment", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/two-factor/verify-totp", { code: wrongCode(secret) }, cookie);
    expect(res.status).toBe(401);
  });

  it("the right code confirms it and turns two-factor on", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/two-factor/verify-totp", { code: totp(secret) }, cookie);
    expect(res.status).toBe(200);
    // better-auth replaces the session so the cookie carries the new flag.
    cookie = sessionCookie(res.headers) || cookie;

    const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    expect(user!.twoFactorEnabled).toBe(true);
    const [row] = await db.select().from(authTwoFactors).where(eq(authTwoFactors.userId, userId));
    expect(row!.verified).toBe(true);
  });

  it("with the requirement on, the enrolled admin gets through", async () => {
    if (!dbAvailable) return;
    process.env.KITSUDEN_ADMIN_MFA = "required";
    try {
      const res = await app.request(req("/api/settings", {}, cookie));
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      expect(body.reason).not.toBe("MFA_REQUIRED");
      expect(res.status).not.toBe(403);
    } finally {
      delete process.env.KITSUDEN_ADMIN_MFA;
    }
  });

  it("password sign-in now asks for the code and opens NO session", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/sign-in/email", { email: adminEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    expect(body.twoFactorRedirect).toBe(true);
    expect(body.twoFactorMethods).toContain("totp");
    expect(cookieNamed(res, "session_token")).toBeUndefined();
    expect(cookieNamed(res, "two_factor")).toBeDefined();
  });

  it("the challenge cookie plus a wrong code: 401, no session", async () => {
    if (!dbAvailable) return;
    const signIn = await post("/api/auth/sign-in/email", { email: adminEmail, password: PASSWORD });
    const challenge = cookieNamed(signIn, "two_factor")!;
    const res = await post(
      "/api/auth/two-factor/verify-totp",
      { code: wrongCode(secret) },
      challenge
    );
    expect(res.status).toBe(401);
    expect(cookieNamed(res, "session_token")).toBeUndefined();
  });

  it("the challenge cookie plus the right code: a session", async () => {
    if (!dbAvailable) return;
    const signIn = await post("/api/auth/sign-in/email", { email: adminEmail, password: PASSWORD });
    const challenge = cookieNamed(signIn, "two_factor")!;
    const res = await post("/api/auth/two-factor/verify-totp", { code: totp(secret) }, challenge);
    expect(res.status).toBe(200);
    const session = cookieNamed(res, "session_token");
    expect(session).toBeDefined();

    const who = await app.request(req("/api/auth/get-session", {}, session));
    const body = (await who.json()) as { user?: { email?: string; twoFactorEnabled?: boolean } };
    expect(body.user?.email).toBe(adminEmail);
    expect(body.user?.twoFactorEnabled).toBe(true);
  });

  it("a backup code signs in once, and only once", async () => {
    if (!dbAvailable) return;
    const code = backupCodes[0]!;

    const first = await post("/api/auth/sign-in/email", { email: adminEmail, password: PASSWORD });
    const ok = await post(
      "/api/auth/two-factor/verify-backup-code",
      { code },
      cookieNamed(first, "two_factor")
    );
    expect(ok.status).toBe(200);
    expect(cookieNamed(ok, "session_token")).toBeDefined();

    const second = await post("/api/auth/sign-in/email", { email: adminEmail, password: PASSWORD });
    const again = await post(
      "/api/auth/two-factor/verify-backup-code",
      { code },
      cookieNamed(second, "two_factor")
    );
    expect(again.status).toBe(401);
    expect(cookieNamed(again, "session_token")).toBeUndefined();
  });

  it("an account with two-factor gets no magic link", async () => {
    if (!dbAvailable) return;
    const before = (await magicLinkEmails(adminEmail)).length;
    const res = await post("/api/auth/sign-in/magic-link", { email: adminEmail, callbackURL: "/" });
    // Same answer as for anyone: no hint of whether the account exists.
    expect(res.status).toBe(200);
    expect((await magicLinkEmails(adminEmail)).length).toBe(before);
  });

  it("and the link sent before enrolling no longer opens a session", async () => {
    if (!dbAvailable) return;
    const res = await app.request(req(pathOf(linkBeforeEnrolment)));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=");
    expect(cookieNamed(res, "session_token")).toBeUndefined();
  });

  it("a magic link signs a new address in once, lands on the panel, and dies", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/sign-in/magic-link", { email: magicEmail, callbackURL: "/" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });

    const [email] = await magicLinkEmails(magicEmail);
    expect(email).toBeDefined();
    expect(email!.expiresIn).toBe(10);

    // The destination is the panel, never the API root (link-target.ts).
    const link = new URL(email!.url);
    const panel = (process.env.ADMIN_URL || "http://localhost:5173").replace(/\/+$/, "");
    expect(link.searchParams.get("callbackURL")).toBe(`${panel}/`);

    // The token is stored hashed, not as it travels in the link.
    const token = link.searchParams.get("token")!;
    const stored = await db.execute(
      sql`SELECT 1 FROM auth_verifications WHERE identifier = ${`magic-link:${token}`}`
    );
    const storedRows = Array.isArray(stored) ? stored : (stored as { rows: unknown[] }).rows;
    expect(storedRows.length).toBe(0);

    const verify = await app.request(req(pathOf(email!.url)));
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe(`${panel}/`);
    const session = cookieNamed(verify, "session_token");
    expect(session).toBeDefined();

    const who = await app.request(req("/api/auth/get-session", {}, session));
    const body = (await who.json()) as { user?: { email?: string; emailVerified?: boolean } };
    expect(body.user?.email).toBe(magicEmail);
    expect(body.user?.emailVerified).toBe(true);

    // Single use.
    const replay = await app.request(req(pathOf(email!.url)));
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("error=INVALID_TOKEN");
    expect(cookieNamed(replay, "session_token")).toBeUndefined();
  });
});
