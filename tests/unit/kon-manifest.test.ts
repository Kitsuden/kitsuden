/**
 * Kon manifests are validated
 * ============================================================================
 *
 * Four `kon.json` files declared `"$schema": "../../schemas/kon-schema.json"` and
 * that file DID NOT EXIST. Nothing validated the manifests, and the shape drift
 * that allowed was not cosmetic:
 *
 *   - kon-academy-lms (25 tables) and kon-crm (6) declared them in
 *     `database.tables`. No reader consults that field: routes/modules.ts
 *     reads `manifest.tables`, so the panel counted ZERO tables for them.
 *   - kon-agile had both lists at once and they did not match: 8 above, 13
 *     in `database.tables`.
 *
 * The schema lives in packages/schemas/kon-schema.json. The validator here
 * is deliberately small —it covers the subset of draft-07 the schema
 * uses— because the repository has no ajv and adding a dependency for this
 * would be a worse deal than thirty readable lines.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HAS_INSTALLED_KONS } from "./helpers/known-kons";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "packages", "kons");
const SCHEMA = join(ROOT, "packages", "schemas", "kon-schema.json");

function listKons(): string[] {
  return readdirSync(KONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(KONS, e.name, "kon.json")))
    .map((e) => e.name);
}

const read = (route: string) => JSON.parse(readFileSync(route, "utf8"));

// ── Minimal draft-07 validator (only what this schema uses) ─────────────────

type Json = Record<string, unknown>;

function validate(datum: unknown, schema: Json, route = ""): string[] {
  const failures: string[] = [];
  const where = route || "(root)";

  if (schema.const !== undefined && datum !== schema.const) {
    failures.push(`${where}: expected ${JSON.stringify(schema.const)}`);
    return failures;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(datum as never)) {
    failures.push(`${where}: ${JSON.stringify(datum)} is not in ${JSON.stringify(schema.enum)}`);
    return failures;
  }

  if (schema.oneOf) {
    const alternatives = schema.oneOf as Json[];
    if (!alternatives.some((alt) => validate(datum, alt, route).length === 0)) {
      failures.push(`${where}: does not fit any of the allowed shapes`);
    }
    return failures;
  }

  const types = schema.type
    ? Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string]
    : [];
  if (types.length && !types.some((t) => isType(datum, t))) {
    failures.push(`${where}: expected ${types.join("|")}, got ${typeOf(datum)}`);
    return failures;
  }

  if (typeof datum === "string") {
    if (typeof schema.minLength === "number" && datum.length < schema.minLength) {
      failures.push(`${where}: empty or too-short string`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(datum)) {
      failures.push(`${where}: "${datum}" does not satisfy ${schema.pattern}`);
    }
  }

  if (Array.isArray(datum) && schema.items) {
    datum.forEach((elem, i) =>
      failures.push(...validate(elem, schema.items as Json, `${where}[${i}]`))
    );
  }

  if (datum && typeof datum === "object" && !Array.isArray(datum)) {
    const obj = datum as Json;

    for (const req of (schema.required as string[]) || []) {
      if (!(req in obj)) failures.push(`${where}: missing required key "${req}"`);
    }

    // `not: { required: [...] }` — we use it to forbid database.tables
    const no = schema.not as Json | undefined;
    for (const forbidden of (no?.required as string[]) || []) {
      if (forbidden in obj) failures.push(`${where}: the key "${forbidden}" is not allowed here`);
    }

    const props = (schema.properties as Record<string, Json>) || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) failures.push(`${where}: unrecognized key "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) failures.push(...validate(obj[key], sub, route ? `${route}.${key}` : key));
    }

    for (const branch of (schema.allOf as Json[]) || []) {
      const cond = branch.if as Json | undefined;
      const then = branch.then as Json | undefined;
      if (cond && then && validate(obj, cond, route).length === 0) {
        failures.push(...validate(obj, then, route));
      }
    }
  }

  return failures;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function isType(v: unknown, t: string): boolean {
  if (t === "integer") return Number.isInteger(v);
  if (t === "array") return Array.isArray(v);
  if (t === "object") return !!v && typeof v === "object" && !Array.isArray(v);
  if (t === "null") return v === null;
  return typeof v === t;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("kon-schema.json", () => {
  it("it exists where the manifests say it exists", () => {
    // The kon.json files reference it as "../../schemas/kon-schema.json" from
    // packages/kons/<kon>/, which resolves right here.
    expect(existsSync(SCHEMA)).toBe(true);
  });

  it.skipIf(!HAS_INSTALLED_KONS)("there are kons to validate", () => {
    expect(listKons().length).toBeGreaterThan(20);
  });
});

describe.skipIf(!HAS_INSTALLED_KONS)("all kon.json files satisfy the schema", () => {
  const schema = read(SCHEMA) as Json;

  it.each(listKons())("%s", (kon) => {
    const failures = validate(read(join(KONS, kon, "kon.json")), schema);
    expect(failures, `${kon}/kon.json:\n  - ${failures.join("\n  - ")}`).toEqual([]);
  });
});

describe.skipIf(!HAS_INSTALLED_KONS)("the manifest declares ALL the tables the kon creates", () => {
  /**
   * `tables` is not documentation: it is consumed.
   *
   *   · `installKonSchema` uses it to decide whether a kon's installation
   *     went well. What is not declared is not checked.
   *   · `routes/modules.ts` counts rows per declared table, so a missing
   *     table shows up as zero in the panel.
   *
   * Five kons declared too few —crm ×3, members ×2, maps, wiki and
   * ecommerce ×1— and the symptom was exactly that: eight tables that existed, that their
   * own code knew about, and that installation validation did not look at.
   */
  const tableName = (t: unknown) => (typeof t === "string" ? t : (t as { name?: string })?.name);

  /**
   * Tables that the kon's SQL leaves STANDING.
   *
   * Counting `CREATE TABLE` is not enough: kon-booking creates `rooms`, `amenities`…
   * and immediately renames them to `booking_*`. Requiring it to declare the
   * intermediate names would be requiring it to document something that no longer exists.
   */
  function tablesItLeaves(kon: string): string[] {
    const dir = join(KONS, kon, "migrations");
    if (!existsSync(dir)) return [];

    const alive = new Set<string>();
    // `CREATE TABLE IF NOT EXISTS` with variable spacing: without tolerating it, the
    // optional group did not match and literally «if» was captured as a table.
    const creates = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi;
    const renames =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+RENAME\s+TO\s+"?([a-z0-9_]+)"?/gi;

    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      // Without stripping comments, an esports migration that MENTIONS
      // «CREATE TABLE IF NOT EXISTS» inside an explanation was read as
      // DDL and produced a table called «IF».
      const sql = readFileSync(join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--.*/g, " ");

      for (const m of sql.matchAll(creates)) alive.add(m[1]);
      for (const m of sql.matchAll(renames)) {
        alive.delete(m[1]);
        alive.add(m[2]);
      }
    }
    return [...alive];
  }

  it.each(listKons())("%s", (kon) => {
    const manifest = read(join(KONS, kon, "kon.json"));
    const declaredMany = new Set((manifest.tables ?? []).map(tableName));

    // The tables it CREATES and does not declare. The reverse is not checked: a kon with
    // `strategy: "drizzle"` declares tables that drizzle-kit creates, not its SQL.
    const withoutDeclaring = tablesItLeaves(kon).filter((t) => !declaredMany.has(t));

    expect(
      withoutDeclaring,
      `${kon} creates these tables but does not declare them in kon.json, so the ` +
        `install check does not look at them and the panel counts them as ` +
        `zero: ${withoutDeclaring.join(", ")}`
    ).toEqual([]);
  });
});

describe("invariants that the schema alone does not express", () => {
  it("each kon's id matches its folder", () => {
    // Resolution goes by the JSON's `id`, not by the directory name.
    const misaligned = listKons().filter((kon) => read(join(KONS, kon, "kon.json")).id !== kon);

    expect(misaligned).toEqual([]);
  });

  it("they point to the schema with $schema", () => {
    const withoutSchema = listKons().filter((kon) => !read(join(KONS, kon, "kon.json")).$schema);

    expect(
      withoutSchema,
      `Without "$schema" the editor does not validate while typing and drift returns. Kons: ${withoutSchema.join(", ")}`
    ).toEqual([]);
  });

  it("no kon hides tables in database.tables", () => {
    // The field that is read is `tables`. Nobody consults a parallel one inside
    // `database`, and that is how CRM and Academy ended up declaring 31
    // invisible tables between the two.
    const hidden = listKons().filter((kon) => read(join(KONS, kon, "kon.json")).database?.tables);

    expect(hidden).toEqual([]);
  });

  it("kons that mount routes do not collide with each other", () => {
    const byRoute = new Map<string, string[]>();
    for (const kon of listKons()) {
      const route = read(join(KONS, kon, "kon.json")).mount?.path;
      if (route) byRoute.set(route, [...(byRoute.get(route) || []), kon]);
    }

    const collisions = [...byRoute.entries()].filter(([, kons]) => kons.length > 1);

    expect(collisions).toEqual([]);
  });
});
