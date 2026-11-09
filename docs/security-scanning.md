# Security scanning

What scans Kitsuden's code, dependencies, images and running API, what blocks a
merge or a release, and where the exceptions live. The workflows are
`.github/workflows/security.yml` and the `build-docker` job of `ci.yml`. Both
publishing workflows (`publish.yml`, `docker-publish.yml`) call `ci.yml` and
`security.yml` and wait for them, so a release goes out only if the blocking
checks pass.

## What runs

| Check                         | Tool                                                                             | When                                                 | Blocks?                            |
| ----------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Secrets in history and tree   | [gitleaks](https://github.com/gitleaks/gitleaks)                                 | every push and PR                                    | yes, on any finding                |
| Vulnerable dependencies       | [OSV-Scanner](https://github.com/google/osv-scanner) on `pnpm-lock.yaml`         | every push and PR, weekly                            | yes, on CVSS ≥ 7 (HIGH, CRITICAL)  |
| Infrastructure as code        | [Checkov](https://www.checkov.io/): Dockerfiles, GitHub Actions                  | every push and PR                                    | yes, on any failed check           |
| Static analysis (SAST)        | [CodeQL](https://codeql.github.com/) `security-extended`: TS/JS, Python, Actions | every push and PR, weekly                            | through branch rules (see below)   |
| Docker images                 | [Trivy](https://trivy.dev/) on the four built images                             | every push and PR (`ci.yml`)                         | yes, on a fixable HIGH or CRITICAL |
| Running API (DAST)            | [OWASP ZAP](https://www.zaproxy.org/) API scan, from the OpenAPI                 | weekly, push to `main`, by hand                      | not yet                            |
| Dependencies against NVD      | [OWASP Dependency-Check](https://owasp.org/www-project-dependency-check/)        | weekly, push to `main`, by hand, with `NVD_API_KEY`  | not yet                            |
| Secrets (second opinion)      | [GitGuardian](https://www.gitguardian.com/) `ggshield`                           | every push and PR, with `GITGUARDIAN_API_KEY`        | yes                                |
| Dependencies (second opinion) | [Snyk](https://snyk.io/) Open Source                                             | every push and PR, with `SNYK_TOKEN`                 | no: OSV is the gate                |
| MCP server and skill          | [AI-Infra-Guard](agents/red-teaming.md) (Tencent Zhuque Lab)                     | pre-scan on every push; LLM audit with `LLM_API_KEY` | no: findings are an LLM's opinion  |

Beside the scanners, the test suites hold the security regressions: row-level
security, the authorization matrix, injection, XSS, SSRF and the findings of past
audits (`tests/unit/sec-*`, `rls-*`, `security-*`; `apps/api/src/tests/rls-*`).
Dependabot opens updates for npm, the actions, the base images and the compose
images.

Released images carry an SBOM and SLSA provenance, plus a Sigstore-signed
attestation you can check:

```bash
gh attestation verify oci://ghcr.io/kitsuden/kitsuden/api:<version> -R Kitsuden/kitsuden
```

npm packages are published with npm provenance.

## Locally

The CI and a laptop run the same script, with the same versions and exceptions:

```bash
pnpm security:scan                                   # secrets, deps, iac
node scripts/security/scan.mjs --only=deps           # one check
node scripts/security/scan.mjs --image=kitsuden-api:ci   # a built image
```

It needs Node and, for Checkov, `uv`. gitleaks, OSV-Scanner and Trivy are
downloaded once from their GitHub releases into `.security/bin` and checked
against the SHA-256 pinned in `scripts/security/scan.mjs`; reports (SARIF and
JSON) are written to `.security/`, which git ignores. To bump a scanner, change
its version and its three checksums together.

## Exceptions

Fix the finding when you can. When it is a false positive or does not apply,
record it next to the tool, with the reason:

| Tool        | File                | Rule                                                                      |
| ----------- | ------------------- | ------------------------------------------------------------------------- |
| gitleaks    | `.gitleaks.toml`    | a description, and for a file also the exact string (`condition = "AND"`) |
| OSV-Scanner | `osv-scanner.toml`  | `reason` and `ignoreUntil`: the advisory counts again when it expires     |
| Checkov     | `.checkov.yaml`     | a comment above each skipped check                                        |
| Trivy       | `.trivyignore.yaml` | a statement and an expiry date                                            |
| OWASP ZAP   | `.zap/rules.tsv`    | why the alert does not apply                                              |

`tests/unit/security-scanners.test.ts` keeps the scanners pinned, the blocking jobs
blocking and every Checkov and gitleaks exception explained.

## Settings only the repository owner can turn on

These live in GitHub, not in the repository:

- **Secret scanning and push protection** (Settings → Code security).
- **Branch rules for `main`**: require pull requests and the checks of `CI - Quality
Checks` and `Security`, including CodeQL, so its alerts block a merge.
- **Required reviewers on the `release` environment**, which both publishing jobs use.
- **Private vulnerability reporting**, which [SECURITY.md](../SECURITY.md) points to.
- The optional secrets: `GITGUARDIAN_API_KEY`, `SNYK_TOKEN`, `NVD_API_KEY` (free from
  the NVD; without it Dependency-Check takes hours) and `LLM_API_KEY`.

## Not blocking yet, and why

- **OWASP ZAP** and **Dependency-Check** have not run against this code yet. Once a
  run's findings are triaged (fixed, or recorded in `.zap/rules.tsv` or
  `osv-scanner.toml`), drop `continue-on-error` from their jobs.
- **Schemathesis** (`ci.yml`) fails only on a 500 not in its baseline.
- OSV reports MEDIUM and LOW advisories in the log without failing; Dependabot
  proposes their updates.
