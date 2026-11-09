/**
 * The views the panel receives are consistent
 * ============================================================================
 *
 * ── THE FAILURE THIS CATCHES ───────────────────────────────────────────────
 *
 * Nine kons declare `admin.defaultView: "grid"` and no view is called that
 * —the ones generated from tables are called `grid-<table>`—. With
 * `kon-character-builder`, the chain was:
 *
 *   1. The panel opens with `activeViewId = "grid"`.
 *   2. The view filter returns ZERO views.
 *   3. With no active view there is no active table.
 *   4. The create form asked for the schema of a table named after the kon:
 *
 *          No fields available
 *          Could not load schema for table "kon-character-builder"
 *
 * Four layers between the cause —a misspelled id in a JSON— and a message
 * that accuses a table that never existed.
 *
 * ── WHY IT IS A PROBE AND NOT A UNIT TEST ──────────────────────────────────
 *
 * It was tried as a vitest test and it cannot be: that environment forces pg-mem,
 * which does not digest several of the repo's migrations, and `buildAdminRegistry()` ends up
 * returning an empty list. A test that walks zero kons always passes
 * checking nothing — exactly the kind of guard that is useless.
 *
 * Here it runs with the real database:
 *
 *     bun scripts/views-probe.ts
 */

import { buildAdminRegistry } from "../src/services/admin-registry";

let failures = 0;
const ok = (d: string, c: boolean, x = "") => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${d}${x ? ` — ${x}` : ""}`);
  if (!c) failures++;
};

console.log("\nViews the panel receives\n");

const kons = await buildAdminRegistry();

ok("the registry returns kons", kons.length > 5, `${kons.length}`);

// ── 1. The default view exists ──────────────────────────────────────────────
const withoutView = kons
  .filter((k) => k.defaultView)
  .filter((k) => !(k.views ?? []).some((v) => v.id === k.defaultView))
  .map((k) => `${k.id} → "${k.defaultView}"`);

ok(
  "each kon opens on a view from its own list",
  withoutView.length === 0,
  withoutView.join(" | ") || "all exist"
);

// ── 2. A grid without a table leads to the same place ───────────────────────
const gridsWithoutTable: string[] = [];
for (const k of kons) {
  for (const v of k.views ?? []) {
    if (v.type === "custom" || v.type === "element") continue;
    if (!v.table) gridsWithoutTable.push(`${k.id}/${v.id} (${v.type})`);
  }
}

ok(
  "no grid view is left without a table",
  gridsWithoutTable.length === 0,
  gridsWithoutTable.join(" | ") || "all declare one"
);

// ── 3. A kon with tables has something to show ──────────────────────────────
const muted = kons
  .filter((k) => (k.tables ?? []).length > 0 && (k.views ?? []).length === 0)
  .map((k) => k.id);

ok(
  "every kon with tables exposes at least one view",
  muted.length === 0,
  muted.join(", ") || "none mute"
);

console.log(`\n${failures === 0 ? "No failures." : `${failures} failure(s).`}\n`);
process.exit(failures === 0 ? 0 : 1);
