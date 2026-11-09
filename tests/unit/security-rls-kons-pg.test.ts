/**
 * RLS of kon-payments, kon-ecommerce and kon-academy-lms on REAL Postgres
 * ============================================================================
 *
 * PGlite runs as a superuser and skips RLS, so these checks
 * are only valid against a real Postgres with a role that is NOT superuser and has no BYPASSRLS
 * (like `kitsuden_app` in production). They run if these exist:
 *
 *   SEC_PG_ADMIN_URL  — superuser, to seed data
 *   SEC_PG_APP_URL    — application role (NOSUPERUSER NOBYPASSRLS)
 *
 * on a database with ALL migrations applied
 * (`bun run scripts/migrate.ts --all-kons`). Without them, they are skipped.
 *
 * What they demonstrate:
 *   · With the request context (the one the host sets for every kon
 *     since the host started doing so; before, a helper inside kon-payments did it) the DATABASE
 *     only returns the user's rows even if the query does not filter: the
 *     isolation does not depend on remembering the WHERE.
 *   · Shop orders (email, address) are not read by an ordinary
 *     account with RLS context; the team can; and anonymous sign-up keeps
 *     working without context.
 *   · Academy progress is isolated per user with context.
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.SEC_PG_ADMIN_URL;
const APP_URL = process.env.SEC_PG_APP_URL;

describe.skipIf(!ADMIN_URL || !APP_URL)("RLS of the kons against real Postgres", () => {
  let admin: pg.Pool;
  let appPool: pg.Pool;

  /** A query like the app's, with (or without) transaction RLS context. */
  async function asApp<T = Record<string, unknown>>(
    query: string,
    context?: { id: string; role: string }
  ): Promise<T[]> {
    const c = await appPool.connect();
    try {
      await c.query("BEGIN");
      if (context) {
        await c.query(
          "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)",
          [context.id, context.role]
        );
      }
      const r = await c.query(query);
      await c.query("COMMIT");
      return r.rows as T[];
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    appPool = new pg.Pool({ connectionString: APP_URL, max: 4 });

    // The app role CANNOT be a superuser or skip RLS: if it were,
    // everything below would pass by accident.
    const [role] = (
      await appPool.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
      )
    ).rows;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    await admin.query(`
      DELETE FROM pay_subscriptions WHERE user_id IN ('rls-ana','rls-bea');
      INSERT INTO pay_subscriptions (user_id, provider, external_id, status) VALUES
        ('rls-ana', 'stripe', 'sub_rls_ana', 'active'),
        ('rls-bea', 'stripe', 'sub_rls_bea', 'active');

      DELETE FROM shop_order_items WHERE order_id = 'rls-order';
      DELETE FROM shop_orders WHERE id = 'rls-order';
      INSERT INTO shop_orders (id, number, fulfillment_type, customer_email, shipping_address)
        VALUES ('rls-order', 'RLS-000001', 'shipping', 'customer@example.com', '{"line1":"Street 1"}');

      DELETE FROM progreso_cursos WHERE user_id IN ('rls-ana','rls-bea');
      DELETE FROM cursos WHERE id = 'rls-course';
      INSERT INTO cursos (id, titulo, descripcion) VALUES ('rls-course', 'RLS', 'x');
      INSERT INTO progreso_cursos (id, user_id, curso_id) VALUES
        ('rls-pc1', 'rls-ana', 'rls-course'), ('rls-pc2', 'rls-bea', 'rls-course');
    `);
  });

  afterAll(async () => {
    await admin?.end();
    await appPool?.end();
  });

  it("payments: with the request context the database only returns the user's rows, with no WHERE", async () => {
    const rows = await asApp<{ user_id: string }>("SELECT user_id FROM pay_subscriptions", {
      id: "rls-bea",
      role: "user",
    });
    const ofBoth = rows.filter((f) => f.user_id === "rls-ana" || f.user_id === "rls-bea");
    expect(ofBoth.map((f) => f.user_id)).toEqual(["rls-bea"]);
  });

  it("payments: with another account's context a foreign row cannot be written", async () => {
    await expect(
      asApp(
        "INSERT INTO pay_subscriptions (user_id, provider, external_id, status) VALUES ('rls-ana','stripe','sub_rls_fake','active')",
        { id: "rls-bea", role: "" }
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("shop: an ordinary account with context does not read orders; the team does", async () => {
    const q = "SELECT id FROM shop_orders WHERE id = 'rls-order'";
    expect(await asApp(q, { id: "u-anyone", role: "user" })).toHaveLength(0);
    // A request's anonymous user (id '', role `anonymous`) is NOT the system
    // (kon-ecommerce/0003).
    expect(await asApp(q, { id: "", role: "anonymous" })).toHaveLength(0);
    expect(await asApp(q, { id: "u-editor", role: "editor" })).toHaveLength(1);
    expect(await asApp(q, { id: "u-admin", role: "admin" })).toHaveLength(1);
  });

  it("shop: with no context (anonymous order sign-up, workers) it keeps working", async () => {
    expect(await asApp("SELECT id FROM shop_orders WHERE id = 'rls-order'")).toHaveLength(1);
  });

  it("academy: another person's progress is not visible with context", async () => {
    const rows = await asApp<{ user_id: string }>(
      "SELECT user_id FROM progreso_cursos WHERE curso_id = 'rls-course'",
      { id: "rls-ana", role: "user" }
    );
    expect(rows.map((f) => f.user_id)).toEqual(["rls-ana"]);
  });

  it("academy: the index that backs ON CONFLICT for certificates exists", async () => {
    const r = await admin.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'certificados_usuario_curso'"
    );
    expect(r.rows).toHaveLength(1);
  });
});
