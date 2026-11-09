/**
 * The CLI starts programs without a shell. On Windows a `.cmd` shim still has to
 * go through cmd.exe, so that one path refuses anything cmd.exe could read as
 * syntax. A kon id ending up in a command line was how M1 became command
 * execution.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildInvocation, UnsafeArgumentError } from "../../packages/cli/src/utils/run-command";

const ROOT = resolve(__dirname, "../..");

describe("buildInvocation", () => {
  let dir: string;
  const env = () => ({ PATH: dir, PATHEXT: ".EXE;.CMD", ComSpec: "cmd.exe" });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kitsuden-run-command-"));
    writeFileSync(join(dir, "shim.CMD"), "");
    writeFileSync(join(dir, "real.EXE"), "");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("outside Windows the arguments go through untouched", () => {
    const args = ["a&calc", "b; rm -rf /", "$(x)"];
    const i = buildInvocation("tool", args, { platform: "linux" });
    expect(i).toEqual({ file: "tool", args, windowsVerbatimArguments: false });
  });

  it("a real .exe starts directly on Windows, with any argument", () => {
    const args = ["a&calc"];
    const i = buildInvocation("real", args, { platform: "win32", env: env() });
    expect(i.file).toBe(join(dir, "real.EXE"));
    expect(i.args).toEqual(args);
    expect(i.windowsVerbatimArguments).toBe(false);
  });

  it("a .cmd shim goes through cmd.exe with safe arguments", () => {
    const i = buildInvocation("shim", ["install", "--ignore-scripts", "--kon", "kon-blog"], {
      platform: "win32",
      env: env(),
    });
    expect(i.file).toBe("cmd.exe");
    expect(i.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(i.args[3]).toBe(`""${join(dir, "shim.CMD")}" install --ignore-scripts --kon kon-blog"`);
    expect(i.windowsVerbatimArguments).toBe(true);
  });

  it.each(["a&calc", "a|b", "a>b", "a<b", "a^b", "%PATH%", 'a"b', "a b", "(a)", "a\nb", ""])(
    "a .cmd shim refuses %j",
    (bad) => {
      expect(() => buildInvocation("shim", [bad], { platform: "win32", env: env() })).toThrow(
        UnsafeArgumentError
      );
    }
  );

  it("a command that is not on PATH is left for spawn to report", () => {
    const i = buildInvocation("missing", ["x"], { platform: "win32", env: env() });
    expect(i.file).toBe("missing");
  });
});

describe("the CLI has no shell execution left", () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  it("no shell: true, and no execSync that builds its command", () => {
    const offenders: string[] = [];
    for (const file of sources(join(ROOT, "packages/cli/src"))) {
      const text = readFileSync(file, "utf8");
      if (/shell:\s*(true|process\.platform)/.test(text)) offenders.push(`${file}: shell`);
      if (/execSync\(\s*`[^`]*\$\{/.test(text)) offenders.push(`${file}: interpolated execSync`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("no unowned names in what the CLI generates", () => {
  const text = readFileSync(join(ROOT, "packages/cli/src/commands/init.ts"), "utf8");

  it("no Docker Hub kitsuden/* image, deploy action or old repository", () => {
    expect(text).not.toMatch(/kitsuden\/(api|admin|mcp|web):/);
    expect(text).not.toContain("deploy-action");
    expect(text).not.toContain("github.com/kitsuden/");
    expect(text).not.toContain("@kitsuden/api");
    expect(text).not.toMatch(/GREM/);
  });

  it("every published port of the generated compose is on 127.0.0.1", () => {
    const ports = [...text.matchAll(/^\s+- "(.*:\d+)"$/gm)].map((m) => m[1]);
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p.startsWith("127.0.0.1:"), p).toBe(true);
  });

  it("no default secret, and the API connects with the app role", () => {
    expect(text).not.toMatch(/(PASSWORD|SECRET_KEY|SECRET):?\s*\\?\$\{\w+:-[^}]+\}/);
    expect(text).toContain("DATABASE_URL=postgres://kitsuden_app:");
    expect(text).toContain("DATABASE_ADMIN_URL=postgres://kitsuden:");
  });
});

describe("package names in the repository", () => {
  it("the deleted CLI files stay deleted", () => {
    for (const file of [
      "commands/plugin.ts",
      "commands/grimoire.ts",
      "commands/build.ts",
      "commands/agent.ts",
    ]) {
      expect(() => statSync(join(ROOT, "packages/cli/src", file))).toThrow();
    }
    expect(() => statSync(join(ROOT, "packages/cli/bin/kitsuden.js"))).toThrow();
    expect(readdirSync(join(ROOT, "packages/cli/templates"))).not.toContain("vibecoder");
  });
});
