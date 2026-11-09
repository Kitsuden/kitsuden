/**
 * Native modules are not bundled
 * ============================================================================
 *
 * `sharp` and `@node-rs/argon2` are not JavaScript. Each one picks a different
 * package **at runtime** depending on the platform —`@img/sharp-linuxmusl-x64`,
 * `@node-rs/argon2-linux-x64-musl`— and that `require` is resolved from the
 * folder of the file that runs it.
 *
 * When bundled, their code no longer lives in
 * `node_modules/.pnpm/<package>/node_modules/`, which is where their
 * variants sit next to them, and moves inside `apps/api/dist/index.js`. From
 * there the search climbs through `apps/api/node_modules`, `apps/` and `/app/node_modules`
 * and finds none:
 *
 *     error: Could not load the "sharp" module using the linuxmusl-x64 runtime
 *     error: Failed to load native binding
 *
 * The binaries **were in the image**. What broke was the path.
 *
 * ── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
 *
 * Because the failure does not show up at build time. `bun build` bundles happily,
 * the image is generated, and the container dies on startup. Each iteration cost
 * a full build cycle to discover the next native module.
 *
 * And because reasoning about this goes wrong: when fixing `sharp`, `argon2` was left
 * bundled on purpose, with the argument that it was not at the root of
 * `node_modules` and externalizing it would leave it unresolved. The first half was
 * true; the conclusion, false. The answer was not leaving it inside —that
 * never works for a native module— but also copying
 * `apps/api/node_modules` to the runtime image, which was what was missing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/**
 * Packages that ship a per-platform binary.
 *
 * The list is explicit on purpose: detecting them automatically would require
 * inspecting `node_modules`, which is not reliably in CI. If you add a
 * native dependency, add it here — and if you do not, the failure will show up
 * when the container starts, not here.
 */
const NATIVES = ["sharp", "@node-rs/argon2"];

function buildScript(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "apps", "api", "package.json"), "utf-8"));
  return pkg.scripts?.build ?? "";
}

describe("the API bundle does not swallow native modules", () => {
  const build = buildScript();

  it("the build script exists and uses bun build", () => {
    expect(build).toContain("bun build");
  });

  for (const pkg of NATIVES) {
    it(`${pkg} va --external`, () => {
      expect(
        build.includes(`--external ${pkg}`),
        `apps/api does not mark '${pkg}' as --external, so bun puts it ` +
          `inside dist/index.js. It is a native module: when bundled it loses ` +
          `the path to its platform binary and the container dies on ` +
          `startup with "Failed to load native binding" — even though the binary is ` +
          `in the image.\nCurrent script: ${build}`
      ).toBe(true);
    });
  }

  it("the runtime image copies apps/api/node_modules", () => {
    /**
     * `--external` is only half a solution: it takes the module out of the bundle, but
     * it has to be given somewhere to resolve from. The bundle lives in `apps/api/dist/`, so
     * the search starts at `apps/api/node_modules` — which was not copied.
     */
    const dockerfile = readFileSync(join(ROOT, "docker", "Dockerfile.prod"), "utf-8");

    expect(
      /COPY\s+--from=builder\s+\/app\/apps\/api\/node_modules/.test(dockerfile),
      `docker/Dockerfile.prod no longer copies /app/apps/api/node_modules to the ` +
        `runtime stage. Without it, modules marked --external have nowhere to ` +
        `resolve from apps/api/dist/ and the API dies on startup.`
    ).toBe(true);
  });
});
