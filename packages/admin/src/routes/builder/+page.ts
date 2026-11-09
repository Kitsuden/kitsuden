import { redirect } from "@sveltejs/kit";

/**
 * `/builder` → the Page Builder's page editor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WATCH THE DESTINATION: TWO THINGS ARE CALLED "BUILDER"
 *
 *   · `kon-blocks`  → **Page Builder**, the block one. It is CORE and it is this one.
 *   · `kon-character-builder` → the *character builders* engine (stats, slots, build
 *     codes). It is `specialized` and comes OFF by default.
 *
 * This redirect pointed to `/g/kon-character-builder`, i.e. the second one. Since it is
 * disabled, clicking "new page" inside the Page Builder led to
 * "this kon is not activated" — a dead end in a kon that WAS
 * active, and with no hint as to why.
 *
 * `system-tools-builder` is the key that `grimoire-loader` maps to
 * `BuilderView`, which is the real editor.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const load = () => {
  throw redirect(308, "/g/system-tools/builder");
};
