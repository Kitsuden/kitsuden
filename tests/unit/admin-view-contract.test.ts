/**
 * Contract of framework-agnostic admin views
 * ============================================================================
 *
 * Most of these tests are about SECURITY, and not out of zeal: a view's `src`
 * comes from a `kon.json`, which in a marketplace is third-party content,
 * and ends up turned into a file read by the API. That is exactly the shape
 * of a path traversal, so every vector is pinned down here.
 */

import { describe, expect, test } from "vitest";

import {
  adminAssetUrl,
  createViewContext,
  CustomViewError,
  descriptorFromView,
  isSafeAssetPath,
  isValidElementName,
  isValidKonId,
  resolveCustomView,
} from "../../packages/shared/src/admin-view";

// ── Custom element names ─────────────────────────────────────────────────────

describe("custom element name", () => {
  test("accepts names with a hyphen, which is what the spec requires", () => {
    for (const name of ["broadcast-scoreboard", "kon-crm-board", "x-y", "a1-b2"]) {
      expect(isValidElementName(name), name).toBe(true);
    }
  });

  test("rejects names without a hyphen: the browser would not register them", () => {
    for (const name of ["scoreboard", "Broadcast", "div", ""]) {
      expect(isValidElementName(name), name).toBe(false);
    }
  });

  test("rejects uppercase and odd characters", () => {
    for (const name of ["Broadcast-Board", "broadcast_board", "broadcast board", "-leading"]) {
      expect(isValidElementName(name), name).toBe(false);
    }
  });

  test("rejects the names reserved by the spec, which look valid", () => {
    // They have a hyphen and would pass a naive regex, but the browser rejects them.
    for (const name of ["annotation-xml", "font-face", "missing-glyph"]) {
      expect(isValidElementName(name), name).toBe(false);
    }
  });
});

// ── Artifact paths: the attack surface ───────────────────────────────────────

describe("artifact path — path traversal", () => {
  test("accepts relative paths with a front-end extension", () => {
    for (const src of ["admin/panel.js", "./admin/panel.js", "dist/view.mjs", "style.css"]) {
      expect(isSafeAssetPath(src), src).toBe(true);
    }
  });

  test("rejects escaping the kon's package", () => {
    for (const src of [
      "../../../etc/passwd",
      "admin/../../../../.env",
      "..\\..\\windows\\system32\\config.js",
      "a/../../b.js",
    ]) {
      expect(isSafeAssetPath(src), src).toBe(false);
    }
  });

  test("rejects absolute paths and URLs to another origin", () => {
    for (const src of [
      "/etc/passwd",
      "/admin/panel.js",
      "http://evil.com/x.js",
      "https://evil.com/x.js",
      "//evil.com/x.js",
      "file:///etc/passwd",
      "data:text/javascript,alert(1)",
      "javascript:alert(1)",
    ]) {
      expect(isSafeAssetPath(src), src).toBe(false);
    }
  });

  test("rejects null bytes and Windows separators", () => {
    expect(isSafeAssetPath("panel.js\0.png")).toBe(false);
    expect(isSafeAssetPath("admin\\panel.js")).toBe(false);
  });

  test("only serves front-end artifacts, never sources or secrets", () => {
    for (const src of [
      "panel.ts", // source: compiling is the kon's business
      "panel.svelte",
      "kon.json", // manifest
      ".env",
      "package.json",
      "panel", // no extension
      "panel.js.txt",
    ]) {
      expect(isSafeAssetPath(src), src).toBe(false);
    }
  });

  test("rejects non-string entries without throwing", () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(isSafeAssetPath(bad as unknown as string)).toBe(false);
    }
  });
});

// ── Kon id ──────────────────────────────────────────────────────────────────

describe("kon id", () => {
  test("accepts real ids", () => {
    for (const id of ["kon-broadcast", "kon-crm", "media", "a"]) {
      expect(isValidKonId(id), id).toBe(true);
    }
  });

  test("rejects anything that could alter a path", () => {
    for (const id of [
      "../other",
      "kon/broadcast",
      "Kon-Broadcast",
      "",
      "-starts-with-hyphen",
      "a".repeat(90),
    ]) {
      expect(isValidKonId(id), id).toBe(false);
    }
  });
});

// ── Resolution ───────────────────────────────────────────────────────────────

describe("descriptor resolution", () => {
  test("builds the URL under the API's artifacts path", () => {
    const { url } = resolveCustomView({
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    });
    expect(url).toBe("/api/kons/kon-broadcast/admin-asset/admin/scoreboard.js");
  });

  test("respects an explicit base", () => {
    expect(adminAssetUrl("kon-broadcast", "./a.js", "https://app.example")).toBe(
      "https://app.example/api/kons/kon-broadcast/admin-asset/a.js"
    );
  });

  test("errors carry an actionable code, not an opaque message", () => {
    const cases: [Record<string, string>, string][] = [
      [{ konId: "../x", element: "a-b", src: "a.js" }, "INVALID_KON"],
      [{ konId: "kon-broadcast", element: "nohyphen", src: "a.js" }, "INVALID_ELEMENT"],
      [{ konId: "kon-broadcast", element: "a-b", src: "../../x.js" }, "INVALID_SRC"],
    ];

    for (const [input, code] of cases) {
      try {
        resolveCustomView(input as never);
        throw new Error(`should have thrown for ${JSON.stringify(input)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CustomViewError);
        expect((err as CustomViewError).code).toBe(code);
      }
    }
  });
});

// ── Reading from kon.json ───────────────────────────────────────────────────

describe("descriptor from a declared view", () => {
  test("extracts the descriptor from a view of type element", () => {
    expect(
      descriptorFromView("kon-broadcast", {
        type: "element",
        element: "broadcast-scoreboard",
        src: "./admin/scoreboard.js",
      })
    ).toEqual({
      konId: "kon-broadcast",
      element: "broadcast-scoreboard",
      src: "./admin/scoreboard.js",
    });
  });

  test("returns null for normal views, so it can fall back to the generic path", () => {
    expect(descriptorFromView("kon-broadcast", { type: "grid" })).toBeNull();
    expect(descriptorFromView("kon-broadcast", { type: "custom", element: "a-b" })).toBeNull();
    // Incomplete declaration: it does not blow up either, it simply does not apply.
    expect(descriptorFromView("kon-broadcast", { type: "element", element: "a-b" })).toBeNull();
    expect(descriptorFromView("kon-broadcast", {})).toBeNull();
  });
});

// ── Context handed to the view ───────────────────────────────────────────────

describe("view context", () => {
  test("it is versioned, so it can evolve without breaking third parties", () => {
    const ctx = createViewContext({ konId: "kon-broadcast", viewId: "scoreboard" });
    expect(ctx.version).toBe(1);
    expect(ctx.apiBase).toBe("/api");
  });

  test("NEVER includes the session token", () => {
    const ctx = createViewContext({ konId: "kon-broadcast", viewId: "scoreboard" });
    // The view is third-party code: handing it a token would make it exfiltrable.
    // It calls the API with the browser's cookies, like the rest of the admin.
    const keys = Object.keys(ctx);
    for (const forbidden of ["token", "accessToken", "session", "apiKey", "secret"]) {
      expect(keys, `the context must not expose "${forbidden}"`).not.toContain(forbidden);
    }
    expect(JSON.stringify(ctx)).not.toMatch(/token|secret|password/i);
  });
});
