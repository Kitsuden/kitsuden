/**
 * `NODE_ENV` is read AT RUNTIME, never at compile time.
 *
 * The production image runs a `bun build` bundle, which replaces the
 * literal expression `process.env.NODE_ENV` with the value at compile
 * time ("development" in the Dockerfile). So, in the production container,
 * `if (process.env.NODE_ENV === "production")` was `if (false)`:
 * the GraphQL viewer without a session, the open SQL debugger, the 500s of
 * deferred kons with the raw message and the development origins in
 * better-auth. See `apps/api/src/lib/environment.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

/** Directories whose code ends up inside the API bundle or is loaded by the kons. */
const WATCHED = ["apps/api/src", "packages/engine/src", "packages/core", "packages/kons"];

function files(dir: string, output: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const route = join(dir, name);
    if (statSync(route).isDirectory()) {
      if (/^(tests?|tests-unit|__tests__)$/.test(name)) continue;
      files(route, output);
    } else if (/\.(ts|mts)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$/.test(name)) {
      output.push(route);
    }
  }
  return output;
}

describe("NODE_ENV at runtime", () => {
  it("nobody writes a literal `process.env.NODE_ENV` in the API or kon code", () => {
    const culprits: string[] = [];
    for (const dir of WATCHED) {
      for (const f of files(join(ROOT, dir))) {
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
            if (/process\.env\.NODE_ENV\b/.test(code)) {
              culprits.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
            }
          });
      }
    }
    expect(
      culprits,
      "use inProduction()/rawNodeEnv() from apps/api/src/lib/environment.ts"
    ).toEqual([]);
  });

  it("bundled with `bun build` without NODE_ENV, it still sees the runtime one", () => {
    const version = spawnSync("bun", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (version.status !== 0) {
      console.warn("bun is not available: the bundle check is skipped");
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), "environment-"));
    try {
      const input = join(tmp, "input.ts");
      const mod = join(ROOT, "apps/api/src/lib/environment.ts").replace(/\\/g, "/");
      writeFileSync(
        input,
        `import { inProduction, currentEnvironment } from ${JSON.stringify(mod)};\n` +
          `console.log(JSON.stringify({ prod: inProduction(), environment: currentEnvironment() }));\n`
      );

      const env = { ...process.env };
      delete env.NODE_ENV; // as in the Dockerfile build stage
      const build = spawnSync(
        "bun",
        ["build", input, "--outdir", join(tmp, "out"), "--target", "bun"],
        {
          encoding: "utf8",
          env,
          shell: process.platform === "win32",
        }
      );
      expect(build.status, build.stderr).toBe(0);

      const output = join(tmp, "out", "input.js");
      const run = spawnSync("bun", [output], {
        encoding: "utf8",
        env: { ...env, NODE_ENV: "production" },
        shell: process.platform === "win32",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toEqual({ prod: true, environment: "production" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
