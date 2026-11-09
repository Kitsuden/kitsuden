# Security policy

## Supported versions

Kitsuden is in beta. Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub private vulnerability reporting](https://github.com/Kitsuden/kitsuden/security/advisories/new).

Include what you can of:

- the affected route, package or file, and the version or commit;
- the steps to reproduce it, ideally with a request or a failing test;
- what an attacker gains, and what access they need first.

You can expect an acknowledgement within a week. Once a fix is ready, it is released
with an advisory that credits you, unless you prefer otherwise.

## Scope

In scope: this repository, including the API, the admin panel, the CLI, the SDKs,
the MCP server and the Docker images built from it.

Out of scope: kons from other authors, and problems that need an operator to have
turned off a documented safeguard. See the [threat model](docs/threat-model.md)
for what Kitsuden does and does not defend against.

## How the code is checked

Every push and pull request runs secret scanning (gitleaks), a dependency audit
(OSV-Scanner), infrastructure-as-code checks (Checkov), CodeQL and a Trivy scan of
the Docker images, beside the security test suites. OWASP ZAP and OWASP
Dependency-Check run weekly. Details and how to run them yourself:
[docs/security-scanning.md](docs/security-scanning.md).

## Before you deploy

- Read [docs/install/server.md](docs/install/server.md).
- Set every secret in `.env.production.example` to a generated value. The API refuses
  to start in production with a known placeholder.
- Connect the API with a non-superuser database role, or row-level security does not
  apply. The API checks this at startup.
- Registration is closed by default in production. Set `KITSUDEN_SIGNUP=open` only if
  you want public sign-up.
