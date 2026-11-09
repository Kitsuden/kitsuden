import fs from "fs";
import path from "path";

import { describe, it, expect } from "vitest";

const PROJECT_ROOT = process.cwd();

describe("admin package extraction to packages/admin", () => {
  it('packages/admin/package.json exists and has name "@kitsuden/admin"', () => {
    const pkgPath = path.join(PROJECT_ROOT, "packages", "admin", "package.json");
    expect(fs.existsSync(pkgPath)).toBe(true);

    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    expect(pkg.name).toBe("@kitsuden/admin");
  });

  it("apps/admin does not exist or is empty/symlink", () => {
    const legacyPath = path.join(PROJECT_ROOT, "apps", "admin");

    if (!fs.existsSync(legacyPath)) {
      expect(true).toBe(true);
      return;
    }

    const stats = fs.lstatSync(legacyPath);
    if (stats.isSymbolicLink()) {
      expect(true).toBe(true);
      return;
    }

    if (stats.isDirectory()) {
      const entries = fs.readdirSync(legacyPath);
      expect(entries.length).toBe(0);
      return;
    }

    throw new Error(`apps/admin exists and is not empty/symlink`);
  });

  it("packages/admin/src/routes/g/[id]/+page.svelte exists", () => {
    const routePath = path.join(
      PROJECT_ROOT,
      "packages",
      "admin",
      "src",
      "routes",
      "g",
      "[id]",
      "+page.svelte"
    );
    expect(fs.existsSync(routePath)).toBe(true);
  });

  it("docker/Dockerfile.prod references packages/admin instead of apps/admin", () => {
    const dockerfilePath = path.join(PROJECT_ROOT, "docker", "Dockerfile.prod");
    expect(fs.existsSync(dockerfilePath)).toBe(true);

    const content = fs.readFileSync(dockerfilePath, "utf-8");
    const hasAppsAdmin = content.includes("apps/admin");
    const hasPackagesAdmin = content.includes("packages/admin");

    expect(hasAppsAdmin).toBe(false);
    expect(hasPackagesAdmin).toBe(true);
  });

  it("pnpm-workspace.yaml includes packages/*", () => {
    const workspacePath = path.join(PROJECT_ROOT, "pnpm-workspace.yaml");
    expect(fs.existsSync(workspacePath)).toBe(true);

    const content = fs.readFileSync(workspacePath, "utf-8");
    expect(content).toContain("packages/*");
  });

  it("packages/admin has svelte.config.js and vite.config.ts", () => {
    const svelteConfigPath = path.join(PROJECT_ROOT, "packages", "admin", "svelte.config.js");
    const viteConfigPath = path.join(PROJECT_ROOT, "packages", "admin", "vite.config.ts");

    expect(fs.existsSync(svelteConfigPath)).toBe(true);
    expect(fs.existsSync(viteConfigPath)).toBe(true);
  });
});
