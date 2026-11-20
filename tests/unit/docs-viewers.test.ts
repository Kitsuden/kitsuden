/**
 * lib/docs-viewers.ts: the API documentation viewers served from our own origin.
 *
 *   - the pins are complete (an empty `sri` would let any file through);
 *   - inline configuration cannot close its `<script>` tag;
 *   - the pages load only pinned assets, with SRI and the request's nonce, and
 *     switch off Scalar's telemetry, fonts CDN, agent and MCP;
 *   - without the files, the page says how to get them (503), not a blank screen.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import pins from "../../apps/api/src/lib/docs-viewers.json";

const empty = mkdtempSync(join(tmpdir(), "kitsuden-no-viewers-"));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

// An empty folder first in the search list: on a machine that ran the
// download, the real folder would be found next.
process.env.KITSUDEN_DOCS_VIEWERS_DIR = empty;
const viewers = await import("../../apps/api/src/lib/docs-viewers");

describe("docs viewers", () => {
  it("every pinned file has a sha384 SRI and comes from an exact version", () => {
    for (const [id, v] of Object.entries(pins.viewers)) {
      expect(v.version, id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(v.tarball, id).toContain(`-${v.version}.tgz`);
      expect(v.integrity, id).toMatch(/^sha512-/);
      for (const [file, f] of Object.entries(v.files)) {
        expect(f.sri, `${id}/${file}`).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
      }
    }
  });

  it("inline JSON cannot close the script tag", () => {
    const out = viewers.scriptJson({ a: "</script><script>alert(1)</script>", b: "\u2028&" });
    expect(out).not.toMatch(/<|>|&|\u2028/);
    expect(JSON.parse(out)).toEqual({ a: "</script><script>alert(1)</script>", b: "\u2028&" });
  });

  it("Scalar: pinned asset with SRI and nonce, third-party features off", () => {
    const html = viewers.scalarPage(
      [
        { title: "Kitsuden API", slug: "kitsuden", url: "/api/docs/openapi.json" },
        { title: "Blog </script>", slug: "blog", url: "/api/docs/blog/openapi.json" },
      ],
      "N0NCE"
    );
    const v = pins.viewers.scalar;
    expect(html).toContain(
      `src="/api/docs/assets/scalar@${v.version}/standalone.js" integrity="${v.files["standalone.js"].sri}"`
    );
    expect(html.match(/<script[^>]*>/g)?.every((t) => t.includes('nonce="N0NCE"'))).toBe(true);
    expect(html).not.toContain("Blog </script>");
    for (const off of [
      '"telemetry":false',
      '"withDefaultFonts":false',
      '"agent":{"disabled":true}',
      '"mcp":{"disabled":true}',
    ]) {
      expect(html).toContain(off);
    }
    expect(html).toContain('"default":true');
  });

  it("Swagger UI: pinned assets, no validator badge", () => {
    const html = viewers.swaggerPage("/api/docs/openapi.json", "N0NCE");
    const v = pins.viewers["swagger-ui"];
    expect(html).toContain(`href="/api/docs/assets/swagger-ui@${v.version}/swagger-ui.css"`);
    expect(html).toContain(`integrity="${v.files["swagger-ui-bundle.js"].sri}"`);
    expect(html).toContain('"validatorUrl":"none"');
  });

  it("the CSP allows our origin and the nonce, nothing else", () => {
    const csp = viewers.viewerCsp("N0NCE");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-N0NCE'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("only pinned names are files; without them the page explains how to get them", () => {
    const v = pins.viewers.scalar.version;
    expect(viewers.viewerAsset(`scalar@${v}`, "../../package.json")).toBeNull();
    expect(viewers.viewerAsset(`scalar@${v}`, "toString")).toBeNull();
    expect(viewers.viewerAsset("scalar@0.0.0", "standalone.js")).toBeNull();
    expect(viewers.viewerAsset("../scalar", "standalone.js")).toBeNull();
    expect(viewers.missingViewersPage()).toContain("node scripts/docs-viewers.mjs");
  });
});
