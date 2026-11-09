/**
 * Is what runs in the container what is in the code?
 * ============================================================================
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * The panel showed TWO cards for the same kon: «kon-blog» and «blog». The
 * fix —a deduplication by canonical key— had been written for days in
 * `routes/modules.ts`… and was not deployed. Checked inside the
 * container:
 *
 *     canonicalKey in src:  0        (in the repo: 5)
 *     file size:             37582    (in the repo: 41473)
 *
 * The SOURCE had been verified, not the CONTAINER. A `grep` on the repo
 * confirms that the fix was written; it says absolutely nothing about what
 * is serving requests.
 *
 * This probe asks the running API. It runs AFTER deploying:
 *
 *     bun scripts/deployment-probe.ts
 */

const BASE = process.env.PROBE_BASE_URL || "http://localhost:3000";

let failures = 0;
const ok = (d: string, c: boolean, x = "") => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${d}${x ? ` — ${x}` : ""}`);
  if (!c) failures++;
};

console.log("\nDeployment status\n");

// ── One kon, one card ───────────────────────────────────────────────────────
const res = await fetch(`${BASE}/api/modules`);
const body: any = await res.json();
const modules: any[] = Array.isArray(body) ? body : body.data || body.modules || body.docs || [];

ok("/api/modules responds", res.status === 200, `status ${res.status}`);
ok("returns modules", modules.length > 0, `${modules.length}`);

const byName = new Map<string, string[]>();
for (const m of modules) {
  byName.set(m.name, [...(byName.get(m.name) ?? []), m.key]);
}
const duplicates = [...byName].filter(([, ks]) => ks.length > 1);

ok(
  "no kon appears twice",
  duplicates.length === 0,
  duplicates.map(([n, ks]) => `${n}: ${ks.join(" + ")}`).join(" | ") || "no duplicates"
);

/**
 * And the keys are normalized. `blog` and `kon-blog` are the same kon; their
 * coexisting is what produced the two cards, and also what makes
 * turning one on not turn the other on.
 */
const canonical = new Map<string, string[]>();
for (const m of modules) {
  const c = String(m.key).replace(/^kon-/, "");
  canonical.set(c, [...(canonical.get(c) ?? []), m.key]);
}
const mixed = [...canonical].filter(([, ks]) => new Set(ks).size > 1);

ok(
  "the prefixed form and the unprefixed form do not coexist",
  mixed.length === 0,
  mixed.map(([c, ks]) => `${c}: ${[...new Set(ks)].join(" + ")}`).join(" | ") || "all unique"
);

console.log(`\n${failures === 0 ? "No failures." : `${failures} failure(s).`}\n`);
process.exit(failures === 0 ? 0 : 1);
