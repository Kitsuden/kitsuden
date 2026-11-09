/**
 * Security scanning: scripts/security/scan.mjs and its wiring in CI
 * ============================================================================
 *
 * What must not drift: the scanners run at pinned versions checked by SHA-256, the
 * blocking jobs stay blocking, every exception carries a reason, and the triage of
 * OSV-Scanner's report blocks on HIGH and CRITICAL only. Docs: docs/security-scanning.md.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { argsObject } from "../../scripts/security/aig.mjs";
import { CHECKOV, groupScore, TOOLS, triageOsv } from "../../scripts/security/scan.mjs";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

describe("pinned scanners", () => {
  it.each(Object.entries(TOOLS))("%s has an exact version and a SHA-256 per platform", (_n, t) => {
    expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const platform of ["linux-x64", "darwin-arm64", "win32-x64"]) {
      const [asset, sha] = t.assets[platform as keyof typeof t.assets];
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(t.url(t.version, asset)).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\/releases\//);
    }
  });

  it("Checkov comes from PyPI at an exact version", () => {
    expect(CHECKOV).toMatch(/^checkov==\d+\.\d+\.\d+$/);
  });
});

describe("OSV triage", () => {
  const report = {
    results: [
      {
        packages: [
          {
            package: { name: "a", version: "1.0.0" },
            groups: [
              { ids: ["GHSA-high"], aliases: ["CVE-1", "GHSA-high"], max_severity: "7.5" },
              { ids: ["GHSA-mid"], max_severity: "6.9" },
              { ids: ["GHSA-none"], max_severity: "" },
            ],
          },
        ],
      },
    ],
  };

  it("blocks at CVSS 7 and above, reports the rest", () => {
    const { blocking, other } = triageOsv(report);
    expect(blocking).toEqual([{ pkg: "a@1.0.0", ids: ["CVE-1", "GHSA-high"], score: 7.5 }]);
    expect(other.map((f) => f.ids[0])).toEqual(["GHSA-mid", "GHSA-none"]);
  });

  it("an advisory without a score is reported, never silently dropped", () => {
    expect(groupScore({ max_severity: "" })).toBe(0);
    expect(groupScore({})).toBe(0);
    expect(triageOsv({}).blocking).toEqual([]);
  });
});

describe("AI-Infra-Guard arguments", () => {
  it("--target= keeps every target name whole", () => {
    expect(argsObject(["--target=code,skill"]).targets).toEqual(["code", "skill"]);
    expect(argsObject(["--target=kons"]).targets).toEqual(["kons"]);
    expect(() => argsObject(["--target=nope"])).toThrow(/Unknown target/);
  });
});

describe("workflows", () => {
  const security = read(".github/workflows/security.yml");
  const ci = read(".github/workflows/ci.yml");

  /** The YAML block of one job: from its key to the next job key. */
  const job = (text: string, name: string) => {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[\w-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };

  it("the scanners and CodeQL block, and run on every push and pull request", () => {
    expect(security).toMatch(/push:\n\s+branches: \["\*\*"\]/);
    expect(security).toMatch(/pull_request:/);
    // Job level (4 spaces): a step may be informational, the job may not
    expect(job(security, "scanners")).not.toMatch(/^ {4}continue-on-error/m);
    expect(job(security, "scanners")).toContain("node scripts/security/scan.mjs\n");
    expect(job(security, "codeql")).not.toMatch(/^ {4}continue-on-error/m);
    expect(job(security, "codeql")).toContain("security-extended");
  });

  it("CI checks formatting for real and scans every image with Trivy", () => {
    const lint = job(ci, "lint-and-format");
    expect(lint).toContain("pnpm run format:check");
    expect(lint).not.toContain("continue-on-error");
    const docker = job(ci, "build-docker");
    for (const image of ["api", "admin", "mcp", "web"]) {
      expect(docker).toContain(`tags: kitsuden-${image}:ci`);
      expect(docker).toContain(`--image=kitsuden-${image}:ci`);
    }
  });

  it("released images carry an SBOM and a signed provenance attestation", () => {
    const docker = read(".github/workflows/docker-publish.yml");
    expect(docker).toContain("sbom: true");
    expect(docker).toContain("provenance: mode=max");
    expect(docker).toContain("actions/attest-build-provenance@");
  });

  it("downloaded tools are checked against a SHA-256 before they run", () => {
    expect(job(security, "owasp-dependency-check")).toContain("sha256sum -c -");
  });
});

describe("exceptions", () => {
  it("every Checkov skip has a comment above it", () => {
    const lines = read(".checkov.yaml").split("\n");
    const skips = lines.flatMap((l, i) => (/^\s+- CKV_/.test(l) ? [i] : []));
    for (const i of skips) expect(lines[i - 1], lines[i]).toMatch(/^\s*#/);
  });

  it("every gitleaks allowlist names its reason and stays narrow", () => {
    const blocks = read(".gitleaks.toml").split("[[allowlists]]").slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/description = "[^"]{10,}"/);
      // A file-scoped allowlist must also pin the exact string (AND), or it hides the file
      if (/\.(ts|md)\$/.test(block)) expect(block).toContain('condition = "AND"');
    }
  });
});
