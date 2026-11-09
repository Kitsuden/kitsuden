/**
 * `RATE_LIMIT_ENABLED` really turns off the limiter
 *
 * It was read in `lib/config.ts` and nobody consulted it: the limiter was always
 * on, and Schemathesis (apps/api/scripts/schemathesis.ts) filled up with
 * 429s. Now `limiterEnabled()` decides in the two places that mount it
 * (`critical-features.ts` and each kon's limits in `module-loader.ts`).
 */
import { afterEach, describe, expect, it } from "vitest";

import { limiterEnabled } from "../../apps/api/src/lib/rate-limiter";

const before = process.env.RATE_LIMIT_ENABLED;
afterEach(() => {
  if (before === undefined) delete process.env.RATE_LIMIT_ENABLED;
  else process.env.RATE_LIMIT_ENABLED = before;
});

describe("limiterEnabled", () => {
  it("by default, on", () => {
    delete process.env.RATE_LIMIT_ENABLED;
    expect(limiterEnabled()).toBe(true);
  });

  it("with `true`, on; with anything else, off (the config.ts rule)", () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    expect(limiterEnabled()).toBe(true);
    process.env.RATE_LIMIT_ENABLED = "false";
    expect(limiterEnabled()).toBe(false);
    process.env.RATE_LIMIT_ENABLED = "0";
    expect(limiterEnabled()).toBe(false);
  });

  it("the two places that mount the limiter consult it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lib = join(__dirname, "..", "..", "apps", "api", "src", "lib");
    expect(readFileSync(join(lib, "critical-features.ts"), "utf-8")).toMatch(
      /if \(limiterEnabled\(\)\)/
    );
    expect(readFileSync(join(lib, "module-loader.ts"), "utf-8")).toMatch(
      /if \(!limiterEnabled\(\)\) return;/
    );
  });
});
