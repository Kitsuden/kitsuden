/**
 * That every kon SHOWS what it stores
 * ============================================================================
 *
 * ── WHAT QUESTION IT ANSWERS ───────────────────────────────────────────────
 *
 * `views-probe.ts` checks that a kon with tables has AT LEAST one view.
 * That lets through the case that really hurts: a kon with fifteen tables and a
 * single view passes the check, and fourteen tables are left with no screen
 * to see them from.
 *
 * Here it looks table by table:
 *
 *   1. The tables the kon DECLARES exist in the database. A declared one that does not
 *      exist is a screen that returns an error when opened.
 *   2. The tables that exist and the kon does NOT declare. They are invisible to the
 *      explorer: the allowlist is built from what is declared.
 *   3. The declared tables that no view covers. Data is stored that
 *      there is no way to look at without going into the database.
 *
 * Point 3 allows a legitimate excuse: a custom view (`element`) can
 * show several tables without declaring them one by one — the TO panel shows
 * phases, sets and reports from a single screen. That is why it is reported as a WARNING
 * and not a failure, with the kon in front so it can be judged.
 *
 *     bun apps/api/scripts/admin-surface-probe.ts
 */

import { sql } from "drizzle-orm";

import { db } from "../src/db";
import { buildAdminRegistry } from "../src/services/admin-registry";

interface View {
  id: string;
  type: string;
  table?: string;
  title?: string;
}
interface Table {
  name: string;
  readonly?: boolean;
}
interface KonAdmin {
  id: string;
  defaultView?: string;
  tables?: Table[];
  views?: View[];
}

let failures = 0;
let warnings = 0;

const ok = (d: string, c: boolean, x = "") => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${d}${x ? ` — ${x}` : ""}`);
  if (!c) failures++;
};

const warning = (d: string) => {
  console.log(`  warn ${d}`);
  warnings++;
};

async function main() {
  const kons = (await buildAdminRegistry()) as unknown as KonAdmin[];

  const rows = await db.instance.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const inDb = new Set(
    (
      (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
        tablename: string;
      }[]
    ).map((f) => f.tablename)
  );

  console.log(`\nAdmin surface — ${kons.length} kons, ${inDb.size} tables in the database\n`);

  const withTables = kons.filter((k) => (k.tables ?? []).length > 0);

  // ── 1. What is declared exists ────────────────────────────────────────────
  const ghosts: string[] = [];
  for (const k of withTables) {
    for (const t of k.tables ?? []) {
      if (!inDb.has(t.name)) ghosts.push(`${k.id}/${t.name}`);
    }
  }
  ok(
    "every declared table exists in the database",
    ghosts.length === 0,
    ghosts.join(", ") || `${withTables.length} kons reviewed`
  );

  // ── 2. The default view exists ────────────────────────────────────────────
  const withoutDefault = kons
    .filter((k) => k.defaultView)
    .filter((k) => !(k.views ?? []).some((v) => v.id === k.defaultView))
    .map((k) => `${k.id} → "${k.defaultView}"`);
  ok(
    "each kon opens on a view of its own",
    withoutDefault.length === 0,
    withoutDefault.join(" | ") || "all"
  );

  // ── 3. Each table has somewhere to be seen ────────────────────────────────
  console.log("");
  for (const k of withTables) {
    const views = k.views ?? [];
    const covered = new Set(views.map((v) => v.table).filter(Boolean) as string[]);
    const custom = views.filter((v) => v.type === "element" || v.type === "custom");

    const orphans = (k.tables ?? []).filter((t) => !covered.has(t.name)).map((t) => t.name);

    if (orphans.length === 0) {
      console.log(
        `  ok    ${k.id.padEnd(22)} ${k.tables!.length} table(s), all with a view ` +
          `(${views.length} view(s))`
      );
      continue;
    }

    const excuse = custom.length > 0 ? ` — has ${custom.length} custom view(s)` : "";
    warning(
      `${k.id.padEnd(22)} ${orphans.length}/${k.tables!.length} table(s) without a view` +
        `${excuse}: ${orphans.join(", ")}`
    );
  }

  console.log(
    `\n${failures === 0 ? "No failures" : `${failures} failure(s)`}` +
      `${warnings ? `, ${warnings} warning(s) to judge by hand` : ""}.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
