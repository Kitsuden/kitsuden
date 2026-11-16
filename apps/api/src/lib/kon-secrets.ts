/**
 * `ctx.secrets`: sealed secrets for kons (docs/kons/secrets.md)
 * ============================================================================
 *
 * A kon that connects to someone else's service ends up holding a credential:
 * a refresh token, an API key. Until now it had two choices, both bad: store
 * it readable, or not store it at all (kon-esports chose the second and says
 * why in its importer).
 *
 *   const sealed = ctx.secrets.seal("kon-connections", refreshToken);
 *   // ...store `sealed` in a jsonb column...
 *   const token = await ctx.secrets.open("kon-connections", sealed, {
 *     purpose: "refresh-access-token", subject: `connection:${id}`, actorUserId,
 *   });
 *
 * ── WHAT IT GUARANTEES ─────────────────────────────────────────────────────
 *
 *   · ENCRYPTED AT REST with the installation's secrets key (AES-256-GCM, the
 *     same key and the same rotation script as the core's own secrets).
 *   · BOUND TO THE KON. The kon's id is authenticated with the ciphertext: a
 *     value sealed by one kon does not open for another, and the label cannot
 *     be edited to make it.
 *   · EVERY OPENING IS RECORDED, with its purpose, before the value is handed
 *     over. If the record cannot be written the secret is NOT returned: an
 *     access nobody can see later is the thing this exists to prevent.
 *   · THE VALUE IS NEVER RECORDED. The log has the kon, the purpose, the
 *     subject the kon names, the account and the request.
 *
 * The log is written on the global connection, not the request's: an access
 * happened even if the request that caused it rolls back.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * A kon is code running in the API's process. This is not a sandbox: a kon
 * that wants to misuse a credential it holds can. What this gives is that the
 * database, a backup and the generic read surfaces never show the credential,
 * and that every legitimate use leaves a trace.
 */

// Deep imports, not the facade: the facade reaches the loader, which imports this file.
import {
  isSealedSecret,
  type KonSecretColumn,
  type KonSecrets,
  type SealedSecret,
  type SecretAccess,
} from "@kitsuden/shared";
import { desc, eq, sql } from "drizzle-orm";

import { messageOf } from "../../../../packages/engine/src/errors";
import { useRequest } from "../../../../packages/engine/src/request-scope";
import { db } from "../db";
import { secretAccessLog } from "../db/schema";
import { decryptSecret, encryptSecret } from "../services/secrets";

import { logger } from "./logger";

const KON_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** A secret could not be sealed or opened. The message never carries the value. */
export class KonSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KonSecretError";
  }
}

function aadFor(konId: string): string {
  return `kon:${konId}`;
}

function requireKonId(konId: unknown): asserts konId is string {
  if (typeof konId !== "string" || !KON_ID.test(konId)) {
    throw new KonSecretError("secrets: the kon id is required (the kon's own id)");
  }
}

function clip(value: string | undefined | null, max: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > max ? value.slice(0, max) : value;
}

async function record(
  konId: string,
  outcome: "opened" | "refused",
  access: SecretAccess
): Promise<void> {
  await db.insert(secretAccessLog).values({
    konId,
    outcome,
    purpose: clip(access.purpose, 200) ?? "unspecified",
    subject: clip(access.subject, 300),
    actorUserId: access.actorUserId ?? useRequest()?.user?.id ?? null,
    requestId: useRequest()?.requestId ?? null,
  });
}

export const konSecrets: KonSecrets = {
  seal(konId: string, plaintext: string): SealedSecret {
    requireKonId(konId);
    if (typeof plaintext !== "string" || plaintext === "") {
      throw new KonSecretError("secrets: there is nothing to seal");
    }
    return { v: 1, kon: konId, ...encryptSecret(plaintext, aadFor(konId)) };
  },

  async open(konId: string, sealed: SealedSecret, access: SecretAccess): Promise<string> {
    requireKonId(konId);
    if (!access || typeof access.purpose !== "string" || access.purpose.trim() === "") {
      throw new KonSecretError("secrets: say why the secret is opened (access.purpose)");
    }

    let plaintext: string | null = null;
    let refusal: string | null = null;
    if (!isSealedSecret(sealed)) {
      refusal = "the value is not a sealed secret";
    } else if (sealed.kon !== konId) {
      refusal = "the secret was sealed for another kon";
    } else {
      try {
        plaintext = decryptSecret(sealed, aadFor(konId));
      } catch {
        // Tampered with, or the installation's key changed without a rekey.
        refusal = "the secret does not open with this installation's key";
      }
    }

    try {
      await record(konId, plaintext === null ? "refused" : "opened", access);
    } catch (err: unknown) {
      logger.error({ err: messageOf(err), konId }, "[secrets] the access could not be recorded");
      throw new KonSecretError("secrets: the access could not be recorded, so nothing was opened");
    }

    if (plaintext === null) throw new KonSecretError(`secrets: ${refusal}`);
    return plaintext;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Where kons keep sealed secrets (for the offline rekey)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stores what the kon declared in `defineKon({ secretColumns })`, replacing
 * what it had declared before. Returns the declarations it refused.
 */
export async function registerKonSecretColumns(
  konId: string,
  columns: readonly KonSecretColumn[] | undefined
): Promise<string[]> {
  const problems: string[] = [];
  const valid: Array<{ table: string; column: string; idColumn: string }> = [];
  for (const declared of columns ?? []) {
    const idColumn = declared?.idColumn ?? "id";
    if (
      !declared ||
      !IDENTIFIER.test(String(declared.table)) ||
      !IDENTIFIER.test(String(declared.column)) ||
      !IDENTIFIER.test(idColumn)
    ) {
      problems.push(
        `secretColumns: "${String(declared?.table)}.${String(declared?.column)}" is not a valid table and column`
      );
      continue;
    }
    valid.push({ table: declared.table, column: declared.column, idColumn });
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM kitsuden_secret_columns WHERE kon_id = ${konId}`);
    for (const c of valid) {
      await tx.execute(sql`
        INSERT INTO kitsuden_secret_columns (kon_id, table_name, column_name, id_column, updated_at)
        VALUES (${konId}, ${c.table}, ${c.column}, ${c.idColumn}, now())
        ON CONFLICT (table_name, column_name)
        DO UPDATE SET kon_id = EXCLUDED.kon_id, id_column = EXCLUDED.id_column, updated_at = now()`);
    }
  });
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the log (administrators, through the API)
// ─────────────────────────────────────────────────────────────────────────────

export interface SecretAccessEntry {
  id: string;
  konId: string;
  outcome: string;
  purpose: string;
  subject: string | null;
  actorUserId: string | null;
  requestId: string | null;
  createdAt: Date;
}

export async function listSecretAccess(
  options: { konId?: string; limit?: number } = {}
): Promise<SecretAccessEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const query = db.select().from(secretAccessLog);
  const filtered = options.konId ? query.where(eq(secretAccessLog.konId, options.konId)) : query;
  return filtered.orderBy(desc(secretAccessLog.createdAt)).limit(limit);
}
