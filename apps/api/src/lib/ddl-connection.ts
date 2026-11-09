/**
 * Which account the API uses for the DDL it needs on the fly
 * ============================================================================
 *
 * Two things in the running API create tables: activating a kon from the panel
 * (its migrations, `lib/kon-migrations.ts`) and the Vault (`services/vault.ts`,
 * collections as real tables). The app's role CANNOT: it has no CREATE,
 * and that is on purpose (Postgres skips RLS for a superuser and a table's owner
 * can remove it).
 *
 * Until 2026-10-26 the answer was `DATABASE_ADMIN_URL` —the SUPERUSER— in
 * the API process environment. That is: any API flaw, or
 * user code that escaped the sandbox, owned the entire database
 * (`COPY … FROM PROGRAM` included: on the Postgres server too).
 *
 * Now, in order:
 *
 *   1. `DATABASE_DDL_URL`: a LIMITED role (`start-with-check.sh` creates it):
 *      NOSUPERUSER, NOBYPASSRLS, no CREATEROLE or CREATEDB, with CREATE on the
 *      `public` schema and nothing else. It owns only what it creates (tables
 *      of kons activated on the fly, Vault collections). It cannot touch
 *      the core tables, nor read bypassing RLS, nor run programs.
 *   2. `DATABASE_ADMIN_URL`, if it is still in the environment: development, tests, or a
 *      deployment that keeps it on purpose (`KITSUDEN_API_KEEP_ADMIN_URL`).
 *      In the production image startup REMOVES it before launching the API.
 *   3. None: the app's connection is used and the permissions error is explained.
 *
 * See docs/agents/sandbox.md ("Database credentials").
 */

export type DdlConnectionType = "ddl" | "admin" | "app";

export function ddlConnectionConfigured(): { url: string; type: "ddl" | "admin" } | null {
  const app = process.env.DATABASE_URL;
  const ddl = process.env.DATABASE_DDL_URL;
  if (ddl && ddl !== app) return { url: ddl, type: "ddl" };
  const admin = process.env.DATABASE_ADMIN_URL;
  if (admin && admin !== app) return { url: admin, type: "admin" };
  return null;
}

/** Common text for "there is nothing to create tables with". */
export const HINT_WITHOUT_DDL =
  `\n\n  The API connects with a role WITHOUT the CREATE privilege on the schema,` +
  `\n  which is what makes RLS isolation effective.` +
  `\n\n  To create tables on the fly (activating kons, Vault), set` +
  `\n  DATABASE_DDL_URL: a limited role that startup creates by itself` +
  `\n  (docker/start-with-check.sh). Or apply the migrations outside the API:` +
  `\n\n      bun run scripts/migrate.ts --kon <id>   (or restart the container)\n`;
