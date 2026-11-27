/**
 * Sign in with a username, end to end
 * ============================================================================
 *
 * Against the real test database and the real app (lib/auth.ts, migration 0096):
 *
 *   · an admin sets "admin"-style username through `/update-user`; it is stored
 *     lower-case and `/sign-in/username` with the password opens a session;
 *   · a wrong password or an unknown name gets the same 401;
 *   · a user (not staff) cannot set one, and a sign-up cannot carry one
 *     (KITSUDEN_USERNAMES=staff, the default);
 *   · a taken name is refused; `/is-username-available` answers 404;
 *   · an account with two-factor gets `twoFactorRedirect` and no session;
 *   · the database refuses a raw name the sign-in could never find.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { authUsers } from "../db/schema";
import { app } from "../index";

import { isDatabaseAvailable, enterAs, generateTestId, sessionCookie, testIp } from "./setup";

let dbAvailable = false;

const PASSWORD = "TestPassword123!";
const suffix = generateTestId()
  .replace(/[^a-z0-9]/gi, "")
  .toLowerCase()
  .slice(-12);
const adminEmail = `test-username-admin-${suffix}@example.com`;
const userEmail = `test-username-user-${suffix}@example.com`;
const signUpEmail = `test-username-signup-${suffix}@example.com`;
const adminName = `boss_${suffix}`;

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

async function cleanUp() {
  await db.execute(
    sql`DELETE FROM auth_users WHERE email IN (${adminEmail}, ${userEmail}, ${signUpEmail})`
  );
}

describe("sign in with a username", () => {
  let adminCookie = "";
  let adminId = "";
  let userCookie = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    await cleanUp();
    const admin = await enterAs(app, {
      email: adminEmail,
      password: PASSWORD,
      name: "Username Admin",
      role: "admin",
    });
    adminCookie = admin.cookie;
    adminId = admin.userId;
    const user = await enterAs(app, {
      email: userEmail,
      password: PASSWORD,
      name: "Username User",
      role: "user",
    });
    userCookie = user.cookie;
  });

  afterAll(async () => {
    if (dbAvailable) await cleanUp();
  });

  it("an admin sets a username; it is stored lower-case", async () => {
    if (!dbAvailable) return;
    const res = await post(
      "/api/auth/update-user",
      { username: adminName.toUpperCase() },
      adminCookie
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(authUsers).where(eq(authUsers.id, adminId));
    expect(row!.username).toBe(adminName);
  });

  it("username + password opens the same session as the email", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/sign-in/username", {
      username: adminName.toUpperCase(),
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string; username?: string } };
    expect(body.user?.email).toBe(adminEmail);
    const cookie = sessionCookie(res.headers);
    expect(cookie).toContain("session_token=");

    const session = await app.request(req("/api/auth/get-session", {}, cookie));
    const data = (await session.json()) as {
      user?: { id?: string; username?: string; role?: string };
    };
    expect(data.user?.id).toBe(adminId);
    expect(data.user?.username).toBe(adminName);
    expect(data.user?.role).toBe("admin");
  });

  it("a wrong password and an unknown name get the same 401", async () => {
    if (!dbAvailable) return;
    const wrong = await post("/api/auth/sign-in/username", {
      username: adminName,
      password: "not-the-password",
    });
    const unknown = await post("/api/auth/sign-in/username", {
      username: `nobody_${suffix}`,
      password: PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = (await wrong.json()) as { code?: string };
    const b = (await unknown.json()) as { code?: string };
    expect(a.code).toBe(b.code);
    expect(
      wrong.headers
        .getSetCookie()
        .some((c) => c.includes("session_token=") && !c.includes("session_token=;"))
    ).toBe(false);
  });

  it("a user who is not staff cannot set a username", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/update-user", { username: `user_${suffix}` }, userCookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("USERNAME_STAFF_ONLY");
    const [row] = await db.select().from(authUsers).where(eq(authUsers.email, userEmail));
    expect(row!.username).toBeNull();
  });

  it("a user can still update other fields of their account", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/update-user", { name: "Renamed User" }, userCookie);
    expect(res.status).toBe(200);
  });

  it("a sign-up cannot carry a username", async () => {
    if (!dbAvailable) return;
    for (const field of ["username", "displayUsername"]) {
      const res = await post("/api/auth/sign-up/email", {
        email: signUpEmail,
        password: PASSWORD,
        name: "Sign Up",
        [field]: `admin${suffix.slice(0, 6)}`,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("USERNAME_NOT_AT_SIGN_UP");
    }
    const rows = await db.select().from(authUsers).where(eq(authUsers.email, signUpEmail));
    expect(rows.length).toBe(0);
  });

  it("a taken name is refused", async () => {
    if (!dbAvailable) return;
    await db.update(authUsers).set({ role: "editor" }).where(eq(authUsers.email, userEmail));
    // The session cache keeps the old role for a few minutes: sign in again.
    const signIn = await post("/api/auth/sign-in/email", { email: userEmail, password: PASSWORD });
    const editorCookie = sessionCookie(signIn.headers);
    const res = await post("/api/auth/update-user", { username: adminName }, editorCookie);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("USERNAME_IS_ALREADY_TAKEN");
  });

  it("whether a name is taken is not answered to anyone", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/is-username-available", { username: adminName });
    expect(res.status).toBe(404);
  });

  it("an account with two-factor gets the challenge, not a session", async () => {
    if (!dbAvailable) return;
    await db.update(authUsers).set({ twoFactorEnabled: true }).where(eq(authUsers.id, adminId));
    try {
      const res = await post("/api/auth/sign-in/username", {
        username: adminName,
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { twoFactorRedirect?: boolean; token?: string };
      expect(body.twoFactorRedirect).toBe(true);
      expect(body.token).toBeUndefined();
    } finally {
      await db.update(authUsers).set({ twoFactorEnabled: false }).where(eq(authUsers.id, adminId));
    }
  });

  it("an unconfirmed email is refused by username too", async () => {
    if (!dbAvailable) return;
    await db.update(authUsers).set({ emailVerified: false }).where(eq(authUsers.id, adminId));
    try {
      const res = await post("/api/auth/sign-in/username", {
        username: adminName,
        password: PASSWORD,
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("EMAIL_NOT_VERIFIED");
    } finally {
      await db.update(authUsers).set({ emailVerified: true }).where(eq(authUsers.id, adminId));
    }
  });

  it("removing the username takes that way in away", async () => {
    if (!dbAvailable) return;
    const res = await post("/api/auth/update-user", { username: null }, adminCookie);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(authUsers).where(eq(authUsers.id, adminId));
    expect(row!.username).toBeNull();
    const signIn = await post("/api/auth/sign-in/username", {
      username: adminName,
      password: PASSWORD,
    });
    expect(signIn.status).toBe(401);
  });

  it("the database refuses a name the sign-in could never find", async () => {
    if (!dbAvailable) return;
    for (const bad of ["Admin", "a@b.com", "ab", "with space"]) {
      let failed = false;
      try {
        await db.execute(sql`UPDATE auth_users SET username = ${bad} WHERE id = ${adminId}`);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    }
  });
});
