import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "bun:test";

/**
 * The TOON codec lives in apps/api/src/lib/toon-tabular.ts and has two copies
 * for packages that cannot depend on the API (the dependency-free SDK, and
 * the standalone MCP server). A copy that falls behind is a client
 * that misreads what the API writes: they are required to be identical.
 */
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (route: string) => readFileSync(join(ROOT, route), "utf8").replace(/\r\n/g, "\n");

describe("copies of the TOON codec", () => {
  const canonical = read("apps/api/src/lib/toon-tabular.ts");
  for (const copy of ["packages/sdk/src/toon.ts", "packages/mcp-server/src/toon.ts"]) {
    it(`${copy} is identical to apps/api/src/lib/toon-tabular.ts`, () => {
      expect(read(copy)).toBe(canonical);
    });
  }
});
