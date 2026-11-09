/**
 * docker/Dockerfile.prod (from an audit):
 *
 *   · a kon that does not compile has to STOP the build — before, an
 *     `|| echo "Warning: ..."` left it as a warning and that is how kon-broadcast got through;
 *   · the API does not run as root (`USER bun`, uid 1000) and owns the
 *     folders it writes to.
 *
 * The real check is building the image and looking at `id` (see the
 * audit report); this prevents it from being undone silently.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const DOCKERFILE = readFileSync(resolve(ROOT, "docker/Dockerfile.prod"), "utf8");
const COMPOSE = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8");

/** The RUN instructions, with their `\` continuations joined and without comments. */
function runInstructions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((l) => /^\s*RUN\s/.test(l));
}

/** The text of a `FROM … AS <name>` stage up to the next one. */
function stage(name: string): string {
  const start = DOCKERFILE.search(new RegExp(`^FROM .+ AS ${name}\\s*$`, "m"));
  expect(start).toBeGreaterThan(-1);
  const rest = DOCKERFILE.slice(start + 1);
  const fin = rest.search(/^FROM /m);
  return fin === -1 ? rest : rest.slice(0, fin);
}

describe("Dockerfile.prod: failures are not covered up", () => {
  it("the kons build does not end in `|| echo` or `|| true`", () => {
    const kons = runInstructions(DOCKERFILE).filter((l) => l.includes("@kitsuden/kon-*"));
    expect(kons.length).toBe(1);
    expect(kons[0]).not.toMatch(/\|\|/);
  });

  it("no build or migration RUN swallows its error with `|| echo`", () => {
    const swallowed = runInstructions(DOCKERFILE).filter((l) => /\|\|\s*echo/.test(l));
    expect(swallowed).toEqual([]);
  });
});

describe("Dockerfile.prod: the API without root", () => {
  const api = stage("api");

  it("the api stage sets USER bun before the CMD", () => {
    const user = api.search(/^USER bun\s*$/m);
    const cmd = api.search(/^CMD /m);
    expect(user).toBeGreaterThan(-1);
    expect(user).toBeLessThan(cmd);
  });

  it("the folders it writes to belong to bun", () => {
    const chown = runInstructions(api).find((l) => l.includes("chown"));
    expect(chown).toBeDefined();
    for (const dir of ["data", "uploads", "logs", "apps/api/.kitsuden"]) {
      expect(chown).toContain(dir);
    }
    expect(chown).toMatch(/chown -R bun:bun/);
  });

  it("the backup (same image) still runs as root on purpose", () => {
    const backup = COMPOSE.slice(COMPOSE.indexOf("kitsuden_backup:"));
    const block = backup.slice(0, backup.search(/\n {2}\w[\w-]*:\n|\nvolumes:/));
    expect(block).toMatch(/user: "0:0"/);
  });
});
