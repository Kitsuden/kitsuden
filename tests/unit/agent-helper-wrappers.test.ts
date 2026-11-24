/**
 * The agent helpers' Spanish names survive 0075 only as wrappers of the English functions
 * ============================================================================
 *
 * A database that came from 0.8 has the agent helpers under Spanish names, with 0.8 bodies that call
 * each other by name, and kon policies written against them. 0075 drops a Spanish helper unless
 * pg_depend shows a dependant, and pg_depend does not see calls inside a function body. So it kept
 * `kitsuden_agente_puede_en_kon` (a policy uses it) and dropped `kitsuden_agente_denegado`, which that
 * body calls: every agent read of the kon's table failed with
 * `function kitsuden_agente_denegado(text) does not exist`.
 *
 * 0095 makes each surviving Spanish name (the helpers and the two dataset wrappers) a wrapper of its
 * English function. These tests run the real
 * agent-functions.sql, 0075 and 0095 on PGlite:
 *   - the 0.8 database: the failure after 0075, and the policy working (and agreeing with the English
 *     function) after 0095;
 *   - a fresh database: no Spanish name is created;
 *   - 0095 twice: the same result.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, "apps/api/src/db", p), "utf8");
const AGENT_FUNCTIONS = read("agent-functions.sql");
const M0075 = read("migrations/0075_english_leftover_names.sql");
const M0095 = read("migrations/0095_agent_helper_wrappers.sql");

const SPANISH = [
  "kitsuden_patron_cubre",
  "kitsuden_agente_concede",
  "kitsuden_agente_denegado",
  "kitsuden_agente_abre_kon",
  "kitsuden_admin_efectivo",
  "kitsuden_staff_efectivo",
  "kitsuden_agente_puede",
  "kitsuden_agente_puede_en_kon",
  "kitsuden_agente_abre_dataset",
  "kitsuden_agente_abre_por_politica",
];

/** The 0.8 helpers a kon policy reaches, with their 0.8 bodies (cms funciones-de-agente.sql). */
const HELPERS_08 = `
CREATE FUNCTION kitsuden_patron_cubre(patron text, requerido text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $FN$
DECLARE p text[]; r text[]; n int; i int;
BEGIN
  IF patron IS NULL OR requerido IS NULL OR patron = '' OR requerido = '' THEN RETURN false; END IF;
  IF patron = requerido THEN RETURN true; END IF;
  p := string_to_array(patron, ':');
  n := array_length(p, 1);
  IF n < 2 THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(p) AS x WHERE x <> '*') THEN RETURN false; END IF;
  r := string_to_array(requerido, ':');
  IF p[n] = '*' THEN
    IF array_length(r, 1) <= n - 1 THEN RETURN false; END IF;
    n := n - 1;
  ELSIF array_length(r, 1) <> n THEN RETURN false;
  END IF;
  FOR i IN 1..n LOOP
    IF p[i] = '*' THEN
      IF coalesce(r[i], '') = '' THEN RETURN false; END IF;
    ELSIF p[i] IS DISTINCT FROM r[i] THEN RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $FN$;

CREATE FUNCTION kitsuden_agente_concede(p_requerido text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE crudo text := coalesce(current_setting('app.agent_scopes', true), ''); s text;
BEGIN
  IF crudo = '' OR p_requerido IS NULL THEN RETURN false; END IF;
  FOREACH s IN ARRAY string_to_array(crudo, ',') LOOP
    IF left(s, 1) = '!' AND kitsuden_patron_cubre(substr(s, 2), p_requerido) THEN RETURN false; END IF;
  END LOOP;
  FOREACH s IN ARRAY string_to_array(crudo, ',') LOOP
    IF left(s, 1) <> '!' AND (s = 'admin' OR s = 'admin:*' OR kitsuden_patron_cubre(s, p_requerido)) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $FN$;

CREATE FUNCTION kitsuden_agente_denegado(p_requerido text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE crudo text := coalesce(current_setting('app.agent_scopes', true), ''); s text;
BEGIN
  IF crudo = '' THEN RETURN false; END IF;
  FOREACH s IN ARRAY string_to_array(crudo, ',') LOOP
    IF left(s, 1) = '!' AND kitsuden_patron_cubre(substr(s, 2), p_requerido) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $FN$;

CREATE FUNCTION kitsuden_agente_abre_kon(p_kon text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE crudo text := coalesce(current_setting('app.agent_scopes', true), ''); amplios text[]; s text;
BEGIN
  IF crudo = '' OR coalesce(p_kon, '') = '' THEN RETURN false; END IF;
  IF coalesce(current_setting('app.current_user_role', true), '') <> 'agent' THEN RETURN false; END IF;
  amplios := ARRAY[p_kon || ':*', 'kon:' || p_kon || ':*'];
  FOREACH s IN ARRAY string_to_array(crudo, ',') LOOP
    IF left(s, 1) = '!' AND (kitsuden_patron_cubre(substr(s, 2), amplios[1])
                             OR kitsuden_patron_cubre(substr(s, 2), amplios[2])) THEN
      RETURN false;
    END IF;
  END LOOP;
  FOREACH s IN ARRAY string_to_array(crudo, ',') LOOP
    IF s = 'admin' OR s = 'admin:*' OR s = ANY (amplios) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $FN$;

CREATE FUNCTION kitsuden_agente_puede_en_kon(p_kon text, p_requerido text)
RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT coalesce(current_setting('app.current_user_role', true), '') = 'agent'
     AND NOT kitsuden_agente_denegado(p_kon || ':*')
     AND NOT kitsuden_agente_denegado('kon:' || p_kon || ':*')
     AND NOT kitsuden_agente_denegado(p_requerido)
     AND (kitsuden_agente_abre_kon(p_kon) OR kitsuden_agente_concede(p_requerido))
$FN$;

-- A kon table with a policy written against the Spanish name, as 0.8 kon migrations did.
CREATE TABLE members (id int PRIMARY KEY, name text);
INSERT INTO members VALUES (1, 'Ada');
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_agent_read ON members FOR SELECT
  USING (kitsuden_agente_puede_en_kon('members', 'member:view'));
`;

async function existing(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ proname: string }>(
    "SELECT proname FROM pg_proc WHERE proname = ANY($1) ORDER BY 1",
    [SPANISH]
  );
  return r.rows.map((x) => x.proname);
}

/** A role that RLS applies to, acting as an agent with `scopes`. */
async function asAgent(pg: PGlite, scopes: string) {
  await pg.exec("SET ROLE app_reader");
  await pg.query("SELECT set_config('app.current_user_role', 'agent', false)");
  await pg.query("SELECT set_config('app.agent_scopes', $1, false)", [scopes]);
}

async function database08(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(HELPERS_08);
  await pg.exec("CREATE ROLE app_reader; GRANT SELECT ON members TO app_reader;");
  // The runner applies agent-functions.sql before the pending migrations.
  await pg.exec(AGENT_FUNCTIONS);
  return pg;
}

describe("migration 0095 on a database that came from 0.8", () => {
  it("before it: 0075 keeps the policy's helper and drops the one its body calls", async () => {
    const pg = await database08();
    await pg.exec(M0075);
    expect(await existing(pg)).toEqual(["kitsuden_agente_puede_en_kon"]);
    await asAgent(pg, "member:view");
    await expect(pg.query("SELECT * FROM members")).rejects.toThrow(
      /function kitsuden_agente_denegado\(text\) does not exist/
    );
  });

  it("after it: the kept helper calls the English function, and the policy works", async () => {
    const pg = await database08();
    await pg.exec(M0075);
    await pg.exec(M0095);
    // Only the one a policy needs: the 0.8 body that named the others is gone.
    expect(await existing(pg)).toEqual(["kitsuden_agente_puede_en_kon"]);
    const def = await pg.query<{ src: string }>(
      "SELECT prosrc AS src FROM pg_proc WHERE proname = 'kitsuden_agente_puede_en_kon'"
    );
    expect(def.rows[0]!.src).toMatch(/kitsuden_agent_can_in_kon\(\$1, \$2\)/);

    await asAgent(pg, "member:view");
    expect((await pg.query("SELECT * FROM members")).rows).toHaveLength(1);
    await asAgent(pg, "members:*");
    expect((await pg.query("SELECT * FROM members")).rows).toHaveLength(1);
    // A denial still wins, as in the English function.
    await asAgent(pg, "members:*,!member:view");
    expect((await pg.query("SELECT * FROM members")).rows).toHaveLength(0);
    await asAgent(pg, "blog:*");
    expect((await pg.query("SELECT * FROM members")).rows).toHaveLength(0);
  });

  it("agrees with the English function on every scope set", async () => {
    const pg = await database08();
    await pg.exec(M0075);
    await pg.exec(M0095);
    await pg.query("SELECT set_config('app.current_user_role', 'agent', false)");
    for (const scopes of [
      "",
      "member:view",
      "members:*",
      "kon:members:*",
      "!members:*,member:view",
      "admin",
    ]) {
      await pg.query("SELECT set_config('app.agent_scopes', $1, false)", [scopes]);
      const r = await pg.query<{ old: boolean; english: boolean }>(
        `SELECT kitsuden_agente_puede_en_kon('members', 'member:view') AS old,
                kitsuden_agent_can_in_kon('members', 'member:view') AS english`
      );
      expect(r.rows[0]!.old, scopes).toBe(r.rows[0]!.english);
    }
  });

  it("recreates a dropped helper that a function body still calls by name", async () => {
    const pg = await database08();
    await pg.exec(M0075);
    // Created before 0075 dropped its callee; the body is not checked again until it runs.
    await pg.exec(`
      SET check_function_bodies = off;
      CREATE FUNCTION kon_legacy_check() RETURNS boolean LANGUAGE sql STABLE AS
        'SELECT NOT kitsuden_agente_denegado(''members:*'')';
    `);
    await pg.exec(M0095);
    expect(await existing(pg)).toEqual([
      "kitsuden_agente_denegado",
      "kitsuden_agente_puede_en_kon",
    ]);
    await pg.query("SELECT set_config('app.agent_scopes', '!members:*', false)");
    expect((await pg.query<{ ok: boolean }>("SELECT kon_legacy_check() AS ok")).rows[0]!.ok).toBe(
      false
    );
  });

  it("rewrites a dataset wrapper a policy kept, even before its English function exists", async () => {
    const pg = await database08();
    // 0.8's dataset wrapper and a policy on it. 0075 does not touch it; its body calls a helper 0075 drops.
    await pg.exec(`
      CREATE FUNCTION kitsuden_agente_abre_por_politica(p_data_set_id uuid, p_accion text)
      RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
      BEGIN
        RETURN NOT kitsuden_agente_denegado('datasets:guides:' || p_accion);
      END $FN$;
      CREATE TABLE entries (id int PRIMARY KEY, data_set_id uuid);
      INSERT INTO entries VALUES (1, '11111111-1111-4111-8111-111111111111');
      ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
      CREATE POLICY entries_agent_read ON entries FOR SELECT
        USING (kitsuden_agente_abre_por_politica(data_set_id, 'read'));
      GRANT SELECT ON entries TO app_reader;
    `);
    await pg.exec(M0075);
    await asAgent(pg, "mcp:read");
    await expect(pg.query("SELECT * FROM entries")).rejects.toThrow(
      /function kitsuden_agente_denegado\(text\) does not exist/
    );
    await pg.exec("RESET ROLE");

    // 0095 runs before rls-policies.sql creates the English function (the runner's order).
    await pg.exec(M0095);
    await pg.exec(`
      CREATE FUNCTION kitsuden_agent_opens_by_policy(p_data_set_id uuid, p_action text)
      RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT NOT kitsuden_agent_denied('datasets:guides:' || p_action) $$;
    `);
    await asAgent(pg, "mcp:read");
    expect((await pg.query("SELECT * FROM entries")).rows).toHaveLength(1);
    await asAgent(pg, "mcp:read,!datasets:guides:read");
    expect((await pg.query("SELECT * FROM entries")).rows).toHaveLength(0);
  });

  it("runs twice with the same result", async () => {
    const pg = await database08();
    await pg.exec(M0075);
    await pg.exec(M0095);
    await pg.exec(M0095);
    expect(await existing(pg)).toEqual(["kitsuden_agente_puede_en_kon"]);
    await asAgent(pg, "member:view");
    expect((await pg.query("SELECT * FROM members")).rows).toHaveLength(1);
  });
});

describe("migration 0095 on a fresh database", () => {
  it("creates no Spanish name", async () => {
    const pg = new PGlite();
    await pg.exec(AGENT_FUNCTIONS);
    await pg.exec(M0075);
    await pg.exec(M0095);
    await pg.exec(M0095);
    expect(await existing(pg)).toEqual([]);
  });
});
