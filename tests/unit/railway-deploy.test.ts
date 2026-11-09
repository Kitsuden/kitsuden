import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const PROJECT_ROOT = process.cwd();

function readSrc(filePath: string): string {
  const fullPath = join(PROJECT_ROOT, filePath);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  return readFileSync(fullPath, "utf-8");
}

describe("Railway Deploy Implementation", () => {
  it("packages/cli/src/deploy/railway.ts exists", () => {
    const path = "packages/cli/src/deploy/railway.ts";
    expect(existsSync(join(PROJECT_ROOT, path))).toBe(true);
  });

  it("packages/cli/src/deploy/railway.ts exports deployToRailway", () => {
    const content = readSrc("packages/cli/src/deploy/railway.ts");
    const hasExport =
      /export\s+(async\s+)?function\s+deployToRailway/.test(content) ||
      /export\s+\{[^}]*deployToRailway[^}]*\}/s.test(content);
    expect(hasExport).toBe(true);
  });

  it("packages/cli/src/deploy/railway.ts exports RailwayDeployResult (interface or type)", () => {
    const content = readSrc("packages/cli/src/deploy/railway.ts");
    const hasExport =
      /export\s+interface\s+RailwayDeployResult/.test(content) ||
      /export\s+type\s+RailwayDeployResult/.test(content);
    expect(hasExport).toBe(true);
  });

  it('packages/cli/src/commands/deploy.ts imports deployToRailway from "../deploy/railway.js" or "../deploy/railway.ts"', () => {
    const content = readSrc("packages/cli/src/commands/deploy.ts");
    const hasImport =
      /import\s+\{[^}]*deployToRailway[^}]*\}\s+from\s+["']\.\.\/deploy\/railway\.(js|ts)["']/.test(
        content
      );
    expect(hasImport).toBe(true);
  });

  it("packages/cli/src/commands/deploy.ts has detectProvider returning railway when options.railway is true OR railway.json exists", () => {
    const content = readSrc("packages/cli/src/commands/deploy.ts");

    // Function exists
    expect(content).toMatch(/function\s+detectProvider/);

    // Returns "railway" when options.railway is true
    expect(content).toMatch(/if\s*\(\s*options\.railway\s*\)/);
    expect(content).toMatch(/return\s+["']railway["']/);

    // Returns "railway" when railway.json exists
    expect(content).toMatch(
      /existsSync\(\s*join\(\s*projectRoot,\s*["']railway\.json["']\s*\)\s*\)/
    );
  });

  it("packages/cli/src/commands/status.ts has logic to detect Railway (isRailwayProject)", () => {
    const content = readSrc("packages/cli/src/commands/status.ts");

    // Function that detects Railway projects
    expect(content).toMatch(/function\s+isRailwayProject/);

    // Checks for railway.json or Railway env vars
    expect(content).toMatch(/railway\.json/);
    expect(content).toMatch(/RAILWAY_PROJECT_ID|RAILWAY_TOKEN/);
  });

  it("packages/cli/src/deploy/railway.ts creates railway.json if it does not exist", () => {
    const content = readSrc("packages/cli/src/deploy/railway.ts");

    // Looks for railway.json path
    expect(content).toMatch(/railway\.json/);

    // Checks existence before creating
    expect(content).toMatch(/existsSync\(\s*railwayJsonPath\s*\)/);

    // Writes the file
    expect(content).toMatch(/writeFile\(\s*railwayJsonPath/);
  });
});
