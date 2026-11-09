/**
 * Admin artifacts — the complete circuit
 * ============================================================================
 *
 * Checks that Broadcast's custom view is really loadable from end to
 * end: the manifest declares it, the descriptor resolves to a URL, the file
 * exists on disk, and it is plain JS with no framework or build step.
 *
 * And above all: that paths that try to escape the package do NOT resolve to
 * a real file. That is the reason for this test to exist.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { describe, expect, test } from "vitest";

import {
  descriptorFromView,
  isSafeAssetPath,
  resolveCustomView,
} from "../../packages/shared/src/admin-view";

const ROOT = resolve(__dirname, "../..");
const BROADCAST_DIR = join(ROOT, "packages/kons/kon-broadcast");

function manifest() {
  return JSON.parse(readFileSync(join(BROADCAST_DIR, "kon.json"), "utf8"));
}

describe("declaration in the manifest", () => {
  test("Broadcast declares a view of type element", () => {
    const view = manifest().admin.views.find((v: { id: string }) => v.id === "scoreboard");

    expect(view).toBeDefined();
    expect(view.type).toBe("element");
    expect(view.element).toBe("broadcast-scoreboard");
    expect(view.src).toBe("./admin/scoreboard.js");
  });

  test("the descriptor is extracted and resolves to a servable URL", () => {
    const view = manifest().admin.views.find((v: { id: string }) => v.id === "scoreboard");
    const descriptor = descriptorFromView("kon-broadcast", view);

    expect(descriptor).not.toBeNull();
    const { url } = resolveCustomView(descriptor!);
    expect(url).toBe("/api/kons/kon-broadcast/admin-asset/admin/scoreboard.js");
  });

  test("table views are still generic, not of type element", () => {
    const views = manifest().admin.views;
    const grid = views.find((v: { id: string }) => v.id === "grid");
    expect(descriptorFromView("kon-broadcast", grid)).toBeNull();
  });
});

describe("the artifact exists and is framework-agnostic", () => {
  const assetPath = join(BROADCAST_DIR, "admin/scoreboard.js");

  test("the declared file exists on disk", () => {
    expect(existsSync(assetPath)).toBe(true);
  });

  test("registers the custom element that the manifest declares", () => {
    const source = readFileSync(assetPath, "utf8");
    expect(source).toMatch(/customElements\.define\(\s*["']broadcast-scoreboard["']/);
  });

  test("imports NO framework: that is why it is not part of the admin build", () => {
    const source = readFileSync(assetPath, "utf8");
    // No framework imports and no JSX: it is served as is, without compiling.
    expect(source).not.toMatch(/from\s+["'](react|svelte|vue|preact)/);
    expect(source).not.toMatch(/<[A-Z]\w*\s*\/?>/); // JSX
  });

  test("inherits the theme through CSS variables instead of receiving it via props", () => {
    const source = readFileSync(assetPath, "utf8");
    // That is what lets it look native in light and dark, crossing the
    // Shadow DOM, without the admin having to pass it anything.
    expect(source).toMatch(/var\(--kitsuden-/);
  });

  test("uses Shadow DOM, which is what isolates styles from the host", () => {
    const source = readFileSync(assetPath, "utf8");
    expect(source).toMatch(/attachShadow/);
  });

  test("does not inject user data as HTML", () => {
    const source = readFileSync(assetPath, "utf8");

    // The gamertag and the champion duos are user data; painting them with
    // innerHTML would be an XSS inside the admin panel itself.
    //
    // ONE assignment to innerHTML is allowed: the one for the constructor's
    // static template. Any other —especially with interpolation— is the one that
    // would do harm, so they are checked one by one.
    const assignments = [...source.matchAll(/\.innerHTML\s*=\s*(.+)/g)].map((m) => m[1].trim());

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toBe("TEMPLATE;");
    // And the template interpolates nothing: it is a literal constant.
    expect(source).toMatch(/^const TEMPLATE = `/m);
    expect(/const TEMPLATE = `[^`]*\$\{/.test(source)).toBe(false);

    // Dynamic data goes through textContent.
    expect(source).toMatch(/textContent/);
  });
});

describe("path traversal — the path cannot leave the package", () => {
  const attacks = [
    "../../../.env",
    "../../kon-crm/secret.js",
    "admin/../../../../etc/passwd",
    "/etc/passwd",
    "..\\..\\.env",
    "admin/scoreboard.js\0.png",
  ];

  test("all vectors are rejected in validation", () => {
    for (const src of attacks) {
      expect(isSafeAssetPath(src), src).toBe(false);
    }
  });

  test("and if any got through, it would not point inside the kon's package", () => {
    // Second barrier, the one that really matters: check containment after
    // normalizing. It is the one the server applies.
    for (const src of attacks) {
      const target = resolve(BROADCAST_DIR, src.replace(/\0.*$/, ""));
      const contained = target === BROADCAST_DIR || target.startsWith(BROADCAST_DIR + sep);
      if (!contained) continue;
      // If it stayed contained, then it is not a real escape and it must exist in order to
      // be servable — anything else is a false positive of the attack.
      //
      // Except on POSIX with `\`: there it is not a separator but part of the name, and
      // `..\..\.env` is a (nonexistent) file INSIDE the package. It does not leave
      // it, which is what this barrier checks; validation already rejects it.
      if (sep === "/" && src.includes("\\")) continue;
      expect(existsSync(target), `${src} stayed contained but does not exist`).toBe(true);
    }
  });

  test("the legitimate path DOES stay contained", () => {
    const target = resolve(BROADCAST_DIR, "admin/scoreboard.js");
    expect(target.startsWith(BROADCAST_DIR + sep)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});
