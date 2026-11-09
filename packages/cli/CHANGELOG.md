# Changelog

All notable changes to the Kitsuden CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `new <name>`: creates a frontend website from `kitsuden-starter-basic`. It copies the starter without build output or `.env` files, renames the package and writes `.env`. `--install` and `--quickstart` run `pnpm install`. `--api` explains how to install the API; there are no published API images.
- `make kon <name>`: generates a kon that passes the repository's kon guards. It includes a manifest, policy, routes, migration and a route test in `tests/unit`.
- Tests in `packages/cli/tests` (`pnpm --filter @kitsuden/cli test`).

### Changed

- `make policy` needs `--kon`. It adds the policy to `register<Kon>Policy()` in `<kon>.policy.ts` or creates that file. It no longer writes `apps/api/src/policies/`, which nothing loads.
- `make request|job --kon` writes into the kon's root folder instead of `src/<kind>/`. `make test --kon` writes a vitest test to `tests/unit/`.
- `create-kon` and `kon:create` are now aliases of `make kon`.
- `--version` reads the version from `package.json`.

## [0.1.0] - 2025-03-05

### Added

- Initial release of the Kitsuden CLI
- `init` command to scaffold new projects
- `start` command to start services locally
- `stop` command to stop all services
- `logs` command to view container logs
- `mcp` command to run MCP server for AI assistants
- `deploy` command for Docker and cloud deployments
- `status` command to check service status
- Docker Compose generation for local development
- GitHub Actions workflow template
- Support for PostgreSQL with pgvector
- Support for Valkey (Redis alternative)

### Features

- One-command project initialization
- Integrated MCP server for Claude/Cursor
- Hot-reload development setup
- Production-ready Docker configuration
