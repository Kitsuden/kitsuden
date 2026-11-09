/**
 * Data sources (/api/admin/data-sources) on real PostgreSQL.
 *
 * The password used to be stored in the clear (the route said it encrypted it) and
 * `PUT` returned the whole row with it. The sync answered "Sync triggered
 * successfully" and only stamped `lastSyncAt`. These tests pin the fix: the password
 * is an AES-GCM blob in `encrypted_password` that no response carries, and the sync
 * answers 501 without touching `lastSyncAt`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { dataSources } from "../db/schema";
import { decryptSecret, type EncryptedValue } from "../services/secrets";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

const PASSWORD = "s3cret-of-the-source";
const NEW_PASSWORD = "rotated-s3cret";

let dbAvailable = false;
let appInstance: any = null;
let cookie = "";
const created: string[] = [];

function req(path: string, opts: RequestInit = {}): Request {
  const headers = new Headers(opts.headers);
  headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000/api/admin/data-sources${path}`, { ...opts, headers });
}

async function call(path: string, opts: RequestInit = {}) {
  const res = await appInstance.request(req(path, opts));
  const text = await res.text();
  return { status: res.status as number, text, body: JSON.parse(text) as any };
}

async function storedRow(id: string) {
  const [row] = await db.select().from(dataSources).where(eq(dataSources.id, id));
  return row;
}

async function createSource(extra: Record<string, unknown> = {}) {
  const r = await call("", {
    method: "POST",
    body: JSON.stringify({
      name: `ds-${generateTestId()}`,
      type: "postgresql",
      host: "db.example.com",
      port: 5433,
      database: "warehouse",
      username: "reader",
      password: PASSWORD,
      ...extra,
    }),
  });
  if (r.status === 201) created.push(r.body.data.id);
  return r;
}

describe("Data sources HTTP (DB)", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    process.env.KITSUDEN_SECRETS_KEY ??= "test-suite-secrets-key-0123456789abcdef-0123456789";
    appInstance = (await import("../index")).app;
    ({ cookie } = await enterAs(appInstance, {
      email: `data-sources-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Data Sources Admin",
      role: "admin",
    }));
  });

  afterAll(async () => {
    if (dbAvailable && created.length) {
      await db.delete(dataSources).where(inArray(dataSources.id, created));
    }
  });

  it("POST stores the password encrypted and does not return it", async () => {
    if (!dbAvailable) return;

    const r = await createSource();
    expect(r.status).toBe(201);
    expect(r.body.data.hasPassword).toBe(true);
    expect(r.text).not.toContain(PASSWORD);
    expect(r.body.data).not.toHaveProperty("password");
    expect(r.body.data).not.toHaveProperty("encryptedPassword");

    const row = await storedRow(r.body.data.id);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    const blob = row.encryptedPassword as EncryptedValue;
    expect(Object.keys(blob).sort()).toEqual(["authTag", "iv", "valueEncrypted"]);
    expect(decryptSecret(blob)).toBe(PASSWORD);
  });

  it("POST without a password stores none", async () => {
    if (!dbAvailable) return;

    const r = await createSource({ password: undefined });
    expect(r.status).toBe(201);
    expect(r.body.data.hasPassword).toBe(false);
    expect((await storedRow(r.body.data.id)).encryptedPassword).toBeNull();
  });

  it("GET list and GET by id never carry the password", async () => {
    if (!dbAvailable) return;

    const { body } = await createSource();
    const id = body.data.id;

    const list = await call("");
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(PASSWORD);
    expect(list.text).not.toContain("valueEncrypted");
    expect(list.body.data.find((s: any) => s.id === id).hasPassword).toBe(true);

    const one = await call(`/${id}`);
    expect(one.status).toBe(200);
    expect(one.text).not.toContain(PASSWORD);
    expect(one.text).not.toContain("valueEncrypted");
    expect(one.body.data.hasPassword).toBe(true);
  });

  it("PUT re-encrypts a new password and does not return it", async () => {
    if (!dbAvailable) return;

    const { body } = await createSource();
    const id = body.data.id;

    const r = await call(`/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "renamed", password: NEW_PASSWORD }),
    });
    expect(r.status).toBe(200);
    expect(r.body.data.name).toBe("renamed");
    expect(r.body.data.hasPassword).toBe(true);
    expect(r.text).not.toContain(NEW_PASSWORD);
    expect(r.text).not.toContain("valueEncrypted");

    const row = await storedRow(id);
    expect(JSON.stringify(row)).not.toContain(NEW_PASSWORD);
    expect(decryptSecret(row.encryptedPassword as EncryptedValue)).toBe(NEW_PASSWORD);
  });

  it("PUT without a password keeps it, and null removes it", async () => {
    if (!dbAvailable) return;

    const { body } = await createSource();
    const id = body.data.id;

    await call(`/${id}`, { method: "PUT", body: JSON.stringify({ host: "other.example.com" }) });
    expect(decryptSecret((await storedRow(id)).encryptedPassword as EncryptedValue)).toBe(PASSWORD);

    const r = await call(`/${id}`, { method: "PUT", body: JSON.stringify({ password: null }) });
    expect(r.body.data.hasPassword).toBe(false);
    expect((await storedRow(id)).encryptedPassword).toBeNull();
  });

  it("PUT ignores fields outside the allowed ones", async () => {
    if (!dbAvailable) return;

    const { body } = await createSource();
    const id = body.data.id;
    const before = await storedRow(id);

    const r = await call(`/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        encryptedPassword: { valueEncrypted: "00", iv: "00", authTag: "00" },
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    });
    expect(r.status).toBe(200);

    const after = await storedRow(id);
    expect(after.encryptedPassword).toEqual(before.encryptedPassword);
    expect(after.lastSyncAt).toBeNull();
    expect(after.createdAt).toEqual(before.createdAt);
  });

  it("POST /:id/sync answers 501 and does not stamp lastSyncAt", async () => {
    if (!dbAvailable) return;

    const { body } = await createSource();
    const id = body.data.id;

    const r = await call(`/${id}/sync`, { method: "POST" });
    expect(r.status).toBe(501);
    expect(r.body.success).toBe(false);
    expect(r.text).not.toContain("successfully");
    expect((await storedRow(id)).lastSyncAt).toBeNull();
  });

  it("POST /:id/sync on an unknown id is still 404", async () => {
    if (!dbAvailable) return;

    const r = await call(`/00000000-0000-4000-8000-000000000000/sync`, { method: "POST" });
    expect(r.status).toBe(404);
  });
});
