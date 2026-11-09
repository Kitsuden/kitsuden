/**
 * The EFFECTIVE actor: one rule, two languages (TypeScript and SQL), and both say the same
 * ============================================================================
 *
 * Kons recognized agents each in their own way
 * (conta and ecommerce with their plpgsql copy, blog and builder
 * in TypeScript) or did not recognize them at all (dms, members, booking, newsletter: an
 * `admin` agent saw empty lists or 403). The rule now lives ONCE:
 *
 *   packages/engine/src/effective-actor.ts         isEffectiveAdmin, isEffectiveStaff,
 *                                                 agentCan, agentCanInKon
 *   apps/api/src/db/agent-functions.sql       kitsuden_effective_admin, …
 *
 * Here the two are compared with the same table in real Postgres (PGlite),
 * the functions copied from rls-policies.sql are required to stay identical,
 * `can()` must respect a denial even if the kon's rule says yes, and
 * both migration paths must apply the file before the kons.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { can, definePolicy } from "../../packages/engine/src/authz";
import {
  agentCan,
  agentCanInKon,
  isEffectiveAdmin,
  isEffectiveStaff,
} from "../../packages/engine/src/effective-actor";
import { opensWholeKon } from "../../packages/shared/src/agent-permission";

const DB = resolve(__dirname, "../../apps/api/src/db");
const FUNCTIONS = readFileSync(resolve(DB, "agent-functions.sql"), "utf8");

type Scenario = { role: string; scopes: string[] };

const CASES: Scenario[] = [
  { role: "admin", scopes: [] },
  { role: "editor", scopes: [] },
  { role: "user", scopes: [] },
  { role: "anonymous", scopes: [] },
  { role: "agent", scopes: ["admin"] },
  { role: "agent", scopes: ["admin:*"] },
  { role: "agent", scopes: ["crm:*"] },
  { role: "agent", scopes: ["kon:crm:*"] },
  { role: "agent", scopes: ["kon:*"] },
  { role: "agent", scopes: ["crm:view"] },
  { role: "agent", scopes: ["crm:*", "!crm:*"] },
  { role: "agent", scopes: ["admin", "!kon:crm:*"] },
  { role: "agent", scopes: ["admin", "!kon:*"] },
  { role: "agent", scopes: ["crm:*", "!crm:delete"] },
  { role: "agent", scopes: ["mcp:connect"] },
  { role: "agent", scopes: ["members:*"] },
  { role: "agent", scopes: ["member:view"] },
  { role: "agent", scopes: ["member:*", "!members:*"] },
  { role: "agent", scopes: ["admin", "!member:view"] },
  { role: "agent", scopes: ["*:view"] },
  { role: "agent", scopes: ["conta:view", "conta:write"] },
];

const KONS = ["crm", "members", "conta"];
const REQUESTS = ["crm:view", "crm:delete", "member:view", "conta:view", "conta:administer"];

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(FUNCTIONS);
});
afterAll(async () => pg?.close());

async function sqlWith<T>(c: Scenario, query: string, params: unknown[]): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.query(
      "select set_config('app.current_user_id', 'x1', true), set_config('app.current_user_role', $1, true), set_config('app.agent_scopes', $2, true)",
      [c.role, c.role === "agent" ? c.scopes.join(",") : ""]
    );
    return (await tx.query<{ r: T }>(query, params)).rows[0]!.r;
  });
}

const user = (c: Scenario) =>
  c.role === "anonymous"
    ? null
    : { id: "x1", role: c.role, ...(c.role === "agent" ? { scopes: c.scopes } : {}) };

describe("TypeScript and SQL say the same thing", () => {
  for (const c of CASES) {
    const name = `${c.role} ${JSON.stringify(c.scopes)}`;
    it(name, async () => {
      for (const kon of KONS) {
        expect(
          await sqlWith(c, "select kitsuden_effective_admin($1) as r", [kon]),
          `admin ${kon}`
        ).toBe(isEffectiveAdmin(user(c), kon));
        expect(
          await sqlWith(c, "select kitsuden_effective_staff($1) as r", [kon]),
          `staff ${kon}`
        ).toBe(isEffectiveStaff(user(c), kon));
        expect(
          await sqlWith(c, "select kitsuden_agent_opens_kon($1) as r", [kon]),
          `opens ${kon}`
        ).toBe(c.role === "agent" && opensWholeKon(c.scopes, kon));
        for (const p of REQUESTS) {
          expect(
            await sqlWith(c, "select kitsuden_agent_can_in_kon($1, $2) as r", [kon, p]),
            `can_in_kon ${kon} ${p}`
          ).toBe(agentCanInKon(user(c), kon, p));
        }
      }
      for (const p of REQUESTS) {
        expect(await sqlWith(c, "select kitsuden_agent_can($1) as r", [p]), `can ${p}`).toBe(
          agentCan(user(c), p)
        );
      }
    });
  }
});

describe("what was promised", () => {
  it("`<kon>:*` is admin of ITS kon and of no other; `kon:*` is admin of none", () => {
    const ag = (...scopes: string[]) => ({ id: "a", role: "agent", scopes });
    expect(isEffectiveAdmin(ag("crm:*"), "crm")).toBe(true);
    expect(isEffectiveAdmin(ag("crm:*"), "dms")).toBe(false);
    expect(isEffectiveAdmin(ag("crm:*"))).toBe(false);
    expect(isEffectiveAdmin(ag("kon:*"), "crm")).toBe(false);
    expect(isEffectiveAdmin(ag("admin"))).toBe(true);
    expect(isEffectiveStaff({ id: "e", role: "editor" }, "crm")).toBe(true);
    expect(isEffectiveAdmin({ id: "e", role: "editor" }, "crm")).toBe(false);
    // A human with made-up scopes gains nothing from them.
    expect(isEffectiveAdmin({ id: "u", role: "user", scopes: ["admin"] } as never, "crm")).toBe(
      false
    );
  });

  it("`can()`: a denial wins even if the kon's rule says yes", async () => {
    definePolicy("test-ea", { delete: (u) => isEffectiveAdmin(u, "test-ea") });
    const ag = (...scopes: string[]) => ({ id: "a", role: "agent", scopes });
    expect(await can(ag("test-ea:*"), "delete", {}, "test-ea")).toBe(true);
    expect(await can(ag("test-ea:*", "!test-ea:delete"), "delete", {}, "test-ea")).toBe(false);
    expect(await can({ id: "h", role: "admin" }, "delete", {}, "test-ea")).toBe(true);
    // Even if the rule says yes to everyone: the key has it denied.
    definePolicy("test-ea-open", { view: () => true });
    expect(await can(ag("mcp:connect"), "view", {}, "test-ea-open")).toBe(true);
    expect(await can(ag("!test-ea-open:view"), "view", {}, "test-ea-open")).toBe(false);
  });

  it("the three functions copied from rls-policies.sql stay identical", () => {
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    const rls = norm(readFileSync(resolve(DB, "rls-policies.sql"), "utf8"));
    const ours = norm(FUNCTIONS);
    for (const f of ["kitsuden_pattern_covers", "kitsuden_agent_grants", "kitsuden_agent_denied"]) {
      const chunk = (t: string) => {
        const i = t.indexOf(`CREATE OR REPLACE FUNCTION ${f}(`);
        expect(i, f).toBeGreaterThan(-1);
        return t.slice(i, t.indexOf("\n$FN$;", i));
      };
      expect(chunk(ours), f).toBe(chunk(rls));
    }
  });

  it("both migration paths apply the file before the kons' migrations", () => {
    const migrate = readFileSync(resolve(__dirname, "../../apps/api/scripts/migrate.ts"), "utf8");
    expect(migrate).toContain('resolve(here, "../src/db/agent-functions.sql")');
    expect(migrate.indexOf("await applyRlsPolicies([AGENT_FUNCTIONS]);")).toBeLessThan(
      migrate.indexOf("const ms = await apply(f);")
    );
    const hot = readFileSync(
      resolve(__dirname, "../../apps/api/src/lib/kon-migrations.ts"),
      "utf8"
    );
    expect(hot.indexOf("readSqlFile(AGENT_FUNCTIONS")).toBeGreaterThan(-1);
    expect(hot.indexOf("readSqlFile(AGENT_FUNCTIONS")).toBeLessThan(
      hot.indexOf("for (const [i, stmt] of f.statements.entries())")
    );
  });
});
