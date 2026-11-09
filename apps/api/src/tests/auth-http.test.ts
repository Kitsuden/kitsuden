/**
 * Auth HTTP End-to-End Tests
 *
 * Tests authentication flows via HTTP requests through the Hono app.
 * Covers: sign-up, sign-in, session, admin access control.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { authUsers } from "../db/schema";
import { app } from "../index";

import { isDatabaseAvailable, clearTestData, generateTestId, testIp, sessionCookie } from "./setup";

let dbAvailable = false;

// Only the session cookie: the cache one (`session_data`) would keep the old
// role for 5 minutes and the promote-to-admin test would not see it.
const extractCookie = sessionCookie;

// Helper to build request with cookie
function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  // Each request gets its own IP: without a socket they were all the «unknown» client and
  // together exhausted the sign-up/sign-in quotas (see tests/setup.ts).
  headers.set("X-Forwarded-For", testIp());
  return new Request(`http://localhost:3000${path}`, {
    ...opts,
    headers,
  });
}

describe("Auth HTTP", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await clearTestData();
  });

  afterAll(async () => {
    if (dbAvailable) await clearTestData();
  });

  const testEmail = `auth-http-${generateTestId()}@example.com`;
  const testPassword = "TestPassword123!";
  const testName = `Auth HTTP User ${generateTestId()}`;
  let cookie = "";
  let userId = "";

  describe("Sign Up", () => {
    it("should create a user via POST /api/auth/sign-up/email", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/auth/sign-up/email", {
          method: "POST",
          body: JSON.stringify({
            email: testEmail,
            password: testPassword,
            name: testName,
          }),
        })
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe(testEmail);
      expect(body.user.name).toBe(testName);

      userId = body.user.id;
    });

    it("should NOT sign in before the email is verified (403)", async () => {
      if (!dbAvailable) return;

      // `requireEmailVerification: true` (lib/auth.ts, security round
      // of the audit): signing up with someone else's email is no longer enough
      // to sign in with it.
      const res = await app.request(
        req("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({ email: testEmail, password: testPassword }),
        })
      );
      expect(res.status).toBe(403);

      // In a test there is no email to click: it is confirmed in the database.
      await db.update(authUsers).set({ emailVerified: true }).where(eq(authUsers.id, userId));
    });

    it("should reject duplicate sign-up", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/auth/sign-up/email", {
          method: "POST",
          body: JSON.stringify({
            email: testEmail,
            password: testPassword,
            name: testName,
          }),
        })
      );

      // With mandatory email verification, better-auth (≥1.6) does NOT say
      // that the email already exists: it responds 200 with a synthetic user, without a
      // session, so that sign-up cannot be used to find out who has an account.
      // What matters is that no second user is created and nobody gets in.
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.token).toBeNull();
      expect(body.user?.id).not.toBe(userId);

      const rows = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.email, testEmail.toLowerCase()));
      expect(rows.map((f) => f.id)).toEqual([userId]);
    });
  });

  describe("Sign In", () => {
    it("should sign in and return session cookie", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({
            email: testEmail,
            password: testPassword,
          }),
        })
      );

      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("better-auth");

      cookie = extractCookie(res.headers);
    });

    it("should reject sign-in with wrong password", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({
            email: testEmail,
            password: "WrongPassword123!",
          }),
        })
      );

      expect(res.status).toBe(401);
    });

    it("should reject sign-in for non-existent user", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({
            email: `nonexistent-${generateTestId()}@example.com`,
            password: testPassword,
          }),
        })
      );

      expect(res.status).toBe(401);
    });
  });

  describe("Session", () => {
    it("should get session with valid cookie", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/auth/get-session", {}, cookie));

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(userId);
      expect(body.user.email).toBe(testEmail);
    });

    it("should return null session without cookie", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/auth/get-session"));

      expect(res.status).toBe(200);
      // Without a session, better-auth responds `null` (the entire body), not
      // `{ user: null }`.
      const body = (await res.json()) as any;
      expect(body?.user ?? null).toBeNull();
    });

    it("should return null session with invalid cookie", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        req("/api/auth/get-session", {}, "better-auth.session_token=invalid")
      );

      expect(res.status).toBe(200);
      // Without a session, better-auth responds `null` (the entire body), not
      // `{ user: null }`.
      const body = (await res.json()) as any;
      expect(body?.user ?? null).toBeNull();
    });
  });

  describe("Admin Access Control", () => {
    it("should reject /api/admin/registry without auth → 401", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/admin/registry"));
      expect(res.status).toBe(401);
    });

    it("should reject /api/admin/registry as a plain user → 403", async () => {
      if (!dbAvailable) return;

      // Before, any account got in. The authorization matrix
      // (middleware/authorization-matrix.ts) leaves it to `admin` only: the
      // registry shows the schemas of all kons.
      expect(cookie).not.toBe("");
      const res = await app.request(req("/api/admin/registry", {}, cookie));
      expect(res.status).toBe(403);
    });

    it("should promote user to admin and verify role change", async () => {
      if (!dbAvailable) return;

      await db.update(authUsers).set({ role: "admin" }).where(eq(authUsers.id, userId));

      const res = await app.request(req("/api/admin/registry", {}, cookie));
      expect(res.status).toBe(200);
    });
  });

  describe("Sign Out", () => {
    it("should sign out and invalidate cookie", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/auth/sign-out", { method: "POST" }, cookie));

      expect(res.status).toBe(200);

      // Session should be gone after sign-out
      const sessionRes = await app.request(req("/api/auth/get-session", {}, cookie));
      const body = (await sessionRes.json()) as any;
      expect(body?.user ?? null).toBeNull();
    });
  });

  describe("Password Reset Flow", () => {
    it("should request password reset for existing user", async () => {
      if (!dbAvailable) return;

      const res = await app.request(
        // better-auth 1.6 renamed `/forget-password` to `/request-password-reset`
        // (the old one gives 404).
        req("/api/auth/request-password-reset", {
          method: "POST",
          body: JSON.stringify({ email: testEmail }),
        })
      );

      // Even if email is not configured, endpoint should accept the request
      expect([200, 400, 500]).toContain(res.status);
    });
  });
});
