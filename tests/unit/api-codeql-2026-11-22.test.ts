/**
 * CodeQL alerts in apps/api (2026-11-22)
 * ============================================================================
 *
 * Pins the fixes that live in pure functions: the Prometheus label escape
 * (incomplete sanitization), the Toon Protocol decoder (prototype pollution), the
 * schemathesis path filter (regex injection), the seed secret file (clear-text
 * logging) and the admin MFA warning that no longer echoes the environment.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { looksLikeRegex, pathFilter } from "../../apps/api/scripts/lib/path-filter";
import { writeSecretFile } from "../../apps/api/src/db/secret-file";
import { adminMfaMode } from "../../apps/api/src/lib/admin-mfa";
import { prometheusLabelValue } from "../../apps/api/src/lib/prometheus-label";
import { decodeToonProtocol, encodeToonProtocol } from "../../apps/api/src/lib/toon-protocol";

describe("prometheusLabelValue", () => {
  it("escapes backslash first, then quote and line feed", () => {
    expect(prometheusLabelValue("a\\b")).toBe("a\\\\b");
    expect(prometheusLabelValue('say "hi"')).toBe('say \\"hi\\"');
    expect(prometheusLabelValue("one\ntwo")).toBe("one\\ntwo");
    // A trailing backslash can no longer swallow the closing quote
    expect(prometheusLabelValue('x\\"')).toBe('x\\\\\\"');
  });
});

describe("decodeToonProtocol and the prototype chain", () => {
  it("ignores meta and ref paths through __proto__, constructor or prototype", () => {
    const before = ({} as Record<string, unknown>)["polluted"];
    decodeToonProtocol({
      json: { a: {} },
      meta: { "__proto__.polluted": "Infinity", "a.constructor.prototype.polluted": "NaN" },
      refs: { "__proto__.polluted": "a" },
    } as never);
    expect(({} as Record<string, unknown>)["polluted"]).toBe(before);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("still round-trips rich values", () => {
    const input = { when: new Date("2026-01-02T03:04:05Z"), n: 10n, m: new Map([["k", 1]]) };
    const out = decodeToonProtocol(encodeToonProtocol(input)) as typeof input;
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(out.n).toBe(10n);
    expect(out.m.get("k")).toBe(1);
  });
});

describe("schemathesis --only / --skip", () => {
  it("matches a path and what is under it, or exactly with a trailing $", () => {
    const only = pathFilter("/api/dc");
    expect(only("/api/dc")).toBe(true);
    expect(only("/api/dc/import")).toBe(true);
    expect(only("/api/dcx")).toBe(false);

    const skip = pathFilter(
      undefined,
      "/api/dc/blueprints$,/api/dc/blueprints/{id}$,/api/dc/import$"
    );
    expect(skip("/api/dc/blueprints")).toBe(false);
    expect(skip("/api/dc/blueprints/{id}")).toBe(false);
    expect(skip("/api/dc/import")).toBe(false);
    expect(skip("/api/dc/blueprints/{id}/versions")).toBe(true);
    expect(skip("/api/dc/servers")).toBe(true);
  });

  it("no filter keeps everything, and an old regex filter is detected", () => {
    expect(pathFilter()("/api/anything")).toBe(true);
    expect(looksLikeRegex("^(?!/api/dc/(blueprints(/\\{id\\})?|import)$)")).toBe(true);
    expect(looksLikeRegex("/api/dc/blueprints/{id}$,/api/dc")).toBe(false);
  });
});

describe("writeSecretFile", () => {
  it("writes under .kitsuden/ and returns the path, not the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "kitsuden-secret-"));
    try {
      const path = writeSecretFile("seed-admin-password.txt", "s3cret", dir);
      expect(path).toBe(join(dir, ".kitsuden", "seed-admin-password.txt"));
      expect(path).not.toContain("s3cret");
      expect(readFileSync(path, "utf8")).toBe("s3cret\n");
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("KITSUDEN_ADMIN_MFA warning", () => {
  it("treats an unknown value as required without echoing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(adminMfaMode({ KITSUDEN_ADMIN_MFA: "sometimes-xyz" })).toBe("required");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain("sometimes-xyz");
    } finally {
      warn.mockRestore();
    }
  });
});
