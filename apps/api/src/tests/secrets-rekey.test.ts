/**
 * A dedicated KITSUDEN_SECRETS_KEY, and the way an existing install gets one
 * ============================================================================
 *
 * Security review 2026-11-03: without KITSUDEN_SECRETS_KEY the vault's key was
 * derived from BETTER_AUTH_SECRET, in production too. Production now refuses to
 * start without it (`secretsKeyStatus`), and `rekeySecrets` moves the stored
 * secrets (kitsuden_secrets, data_sources.encrypted_password,
 * agent_notify_settings.secret) from the old key to the new one in a single
 * transaction.
 *
 * The test database already holds secrets written by other suites with the key
 * derived from BETTER_AUTH_SECRET: they are re-keyed forward and then back, so
 * the database ends as it started.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { dataSources, kitsudenSecrets } from "../db/schema";
import { decryptWith, deriveSecretsKey, encryptWith, secretsKeyStatus } from "../lib/secrets-key";
import { RekeyError, rekeySecrets } from "../lib/secrets-rekey";
import { createAgent } from "../services/agent-auth";

import { generateTestId, isDatabaseAvailable } from "./setup";

const OLD = process.env.KITSUDEN_SECRETS_KEY || process.env.BETTER_AUTH_SECRET || "";
const NEW = `rekey-test-${generateTestId()}-${"x".repeat(32)}`;
let dbAvailable = false;
const secretKey = `ZZ_REKEY_${Date.now()}`;
let dataSourceId = "";
let agentId = "";

describe("secrets key", () => {
  it("production and public mode refuse to start without KITSUDEN_SECRETS_KEY, and say how to migrate", () => {
    const refused = secretsKeyStatus({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "s".repeat(40),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("rekey-secrets.ts");
      expect(refused.error).toContain("current value of BETTER_AUTH_SECRET");
    }
    expect(secretsKeyStatus({ KITSUDEN_PUBLIC: "true" }).ok).toBe(false);
    expect(
      secretsKeyStatus({ NODE_ENV: "production", KITSUDEN_SECRETS_KEY: "k".repeat(64) })
    ).toEqual({
      ok: true,
      mode: "dedicated",
    });
    // Compatibility: the same value as the session secret starts, warned
    const same = secretsKeyStatus({
      NODE_ENV: "production",
      KITSUDEN_SECRETS_KEY: "s".repeat(40),
      BETTER_AUTH_SECRET: "s".repeat(40),
    });
    expect(same.ok && same.mode).toBe("same-as-session");
    // Development keeps working, warned
    expect(
      secretsKeyStatus({ NODE_ENV: "development", BETTER_AUTH_SECRET: "s".repeat(40) }).ok
    ).toBe(true);
  });

  it("the compatibility value derives the very key the old installs used", () => {
    const sessionSecret = "s".repeat(40);
    const stored = encryptWith(deriveSecretsKey(sessionSecret), "hello");
    // KITSUDEN_SECRETS_KEY = BETTER_AUTH_SECRET → same derivation → it decrypts
    expect(decryptWith(deriveSecretsKey(sessionSecret), stored)).toBe("hello");
  });

  describe("rekeySecrets", () => {
    beforeAll(async () => {
      dbAvailable = (await isDatabaseAvailable()) && OLD.length > 0;
      if (!dbAvailable) return;
      // Left by an interrupted run of this file: they would abort every run.
      await db.execute(sql`DELETE FROM kitsuden_secrets WHERE key LIKE 'ZZ_REKEY_%'`);
      const oldKey = deriveSecretsKey(OLD);
      const v = encryptWith(oldKey, "vault-value");
      await db.insert(kitsudenSecrets).values({
        key: secretKey,
        valueEncrypted: v.valueEncrypted,
        iv: v.iv,
        authTag: v.authTag,
        autoInject: false,
      } as never);
      const [ds] = await db
        .insert(dataSources)
        .values({
          name: `rekey-${generateTestId()}`,
          type: "postgresql",
          encryptedPassword: encryptWith(oldKey, "db-password"),
        } as never)
        .returning({ id: dataSources.id });
      dataSourceId = ds!.id;
      const { agent } = await createAgent({ name: `rekey-${generateTestId()}` });
      agentId = agent.id;
      await db.execute(sql`
        INSERT INTO agent_notify_settings (agent_id, url, secret, updated_at)
        VALUES (${agentId}, 'https://example.com/hook', ${JSON.stringify(encryptWith(oldKey, "hook-secret"))}::jsonb, now())`);
    }, 60_000);

    afterAll(async () => {
      if (!dbAvailable) return;
      await db.delete(kitsudenSecrets).where(eq(kitsudenSecrets.key, secretKey));
      if (dataSourceId) await db.delete(dataSources).where(eq(dataSources.id, dataSourceId));
      if (agentId) await db.execute(sql`DELETE FROM agent_identities WHERE id = ${agentId}`);
    });

    async function current() {
      const [s] = await db.select().from(kitsudenSecrets).where(eq(kitsudenSecrets.key, secretKey));
      const [d] = await db.select().from(dataSources).where(eq(dataSources.id, dataSourceId));
      const raw = (await db.execute(
        sql`SELECT secret FROM agent_notify_settings WHERE agent_id = ${agentId}`
      )) as unknown;
      const rows = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as {
        secret: unknown;
      }[];
      return {
        vault: { valueEncrypted: s!.valueEncrypted, iv: s!.iv, authTag: s!.authTag },
        password: d!.encryptedPassword as never,
        hook: rows[0]!.secret as never,
      };
    }

    it("a row that decrypts with neither key aborts the whole run: nothing changes", async () => {
      if (!dbAvailable) return;
      const stranger = `ZZ_REKEY_STRANGER_${Date.now()}`;
      const v = encryptWith(deriveSecretsKey("a-third-key-nobody-has-0123456789"), "x");
      const before = await current();
      await db.insert(kitsudenSecrets).values({
        key: stranger,
        valueEncrypted: v.valueEncrypted,
        iv: v.iv,
        authTag: v.authTag,
        autoInject: false,
      } as never);
      try {
        let error: unknown = null;
        try {
          await rekeySecrets(db as never, { oldRaw: OLD, newRaw: NEW });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(RekeyError);
        expect(await current()).toEqual(before);
      } finally {
        await db.delete(kitsudenSecrets).where(eq(kitsudenSecrets.key, stranger));
      }
    }, 60_000);

    it("dry run counts; the real run moves the three stores to the new key; twice is harmless; and back", async () => {
      if (!dbAvailable) return;
      const before = await current();
      const dry = await rekeySecrets(db as never, { oldRaw: OLD, newRaw: NEW, dryRun: true });
      expect(dry.stores.kitsuden_secrets!.rekeyed).toBeGreaterThanOrEqual(1);
      expect(await current()).toEqual(before);

      const real = await rekeySecrets(db as never, { oldRaw: OLD, newRaw: NEW });
      expect(real.stores["data_sources.encrypted_password"]!.rekeyed).toBeGreaterThanOrEqual(1);
      expect(real.stores["agent_notify_settings.secret"]!.rekeyed).toBeGreaterThanOrEqual(1);
      const after = await current();
      const newKey = deriveSecretsKey(NEW);
      expect(decryptWith(newKey, after.vault)).toBe("vault-value");
      expect(decryptWith(newKey, after.password)).toBe("db-password");
      expect(decryptWith(newKey, after.hook)).toBe("hook-secret");

      const again = await rekeySecrets(db as never, { oldRaw: OLD, newRaw: NEW });
      expect(again.stores.kitsuden_secrets!.rekeyed).toBe(0);

      // Back to the key the rest of the suite uses
      await rekeySecrets(db as never, { oldRaw: NEW, newRaw: OLD });
      expect(decryptWith(deriveSecretsKey(OLD), (await current()).vault)).toBe("vault-value");
    }, 120_000);

    it("refuses the same key twice", async () => {
      let error: unknown = null;
      try {
        await rekeySecrets(db as never, { oldRaw: "same", newRaw: "same" });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RekeyError);
    });
  });
});
