/**
 * Security audit 2026-11-19 (code-scan-slash-after-increment-read-as-regex):
 * a `/` after postfix `++`/`--` was read as the start of a regex, so the rest
 * of the line (an API call included) disappeared from the scan and a draft
 * could take the turbo route without a human.
 */
import { describe, expect, it } from "vitest";

import { scanCode } from "../../packages/shared/src/code-scan";

const ESCAPED_PATH = String.raw`"\x2fapi\x2fusers\x2f123"`;

describe("scanCode: slash after ++ / --", () => {
  for (const op of ["++", "--"]) {
    it(`sees the API call after 'a${op} /'`, () => {
      const code = `let a = 0; a${op} /1; await kitsuden.api.delete(${ESCAPED_PATH}); a/2;`;
      const scan = scanCode(code);
      expect(scan.apiCalls.map((c) => c.method)).toContain("DELETE");
      expect(scan.findings.map((f) => f.rule)).toContain("ambiguous_slash");
    });
  }

  it("does not flag an ordinary division", () => {
    const scan = scanCode("const a = 4; const b = a / 2;");
    expect(scan.findings.map((f) => f.rule)).not.toContain("ambiguous_slash");
  });
});
