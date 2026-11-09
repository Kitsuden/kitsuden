# Kitsuden API Unit Tests

This directory contains fast, database-free unit tests for the API. They use Bun's built-in test runner and mock external dependencies (PostgreSQL, Redis/Valkey, S3, Better-Auth) via `mock.module`.

## Running the tests

```bash
cd apps/api
bun test src/tests-unit/
```

Run a single suite:

```bash
bun test src/tests-unit/storage.test.ts
```

## Test files

| File                         | Coverage target                                        |
| ---------------------------- | ------------------------------------------------------ |
| `actions-handlers.test.ts`   | Action route handlers                                  |
| `agent-*.test.ts`            | Agent auth, audit, webhooks, handler                   |
| `auth-guard.test.ts`         | `protectRoute` / `requireAdmin` / `requireScope`       |
| `auth-middleware.test.ts`    | `requireAuth` / `requireRole` / `optionalAuth`         |
| `cache.test.ts`              | `cachedQuery` / `invalidateCache`                      |
| `config.test.ts`             | Config exports, feature flags, rate-limit/CORS configs |
| `crud-handlers.test.ts`      | Settings and sync handlers                             |
| `crud-routes.test.ts`        | Inline `dataSetsRoutes` handlers                       |
| `events.test.ts`             | Event emitter                                          |
| `functions-handlers.test.ts` | Function route handlers                                |
| `image.test.ts`              | Image optimization utilities                           |
| `items-handlers.test.ts`     | `items.ts` CRUD handlers                               |
| `logger.test.ts`             | Logger helpers                                         |
| `module-loader-unit.test.ts` | `createKonContext`, kon type guards, dependency sort   |
| `module-registry.test.ts`    | Module registry helpers                                |
| `modules-*.test.ts`          | Module route and mutation handlers                     |
| `permissions.test.ts`        | Dataset permission helpers                             |
| `storage.test.ts`            | S3/MinIO storage operations                            |
| `system-handlers.test.ts`    | Exported `system.ts` handlers                          |
| `system-routes.test.ts`      | Inline `systemRoutes` handlers                         |
| `toon.test.ts`               | Format negotiation middleware (TOON / TRON / auto)     |
| `toon-tabular.test.ts`       | TOON codec vs the reference implementation             |
| `formats.test.ts`            | `auto` choice, round-trip check, shape cache           |
| `toon-mirrors.test.ts`       | SDK / MCP server copies of the codec are identical     |
| `toon-shared-cases.test.ts`  | Shared TOON cases for the Python SDK                   |
| `transactional-rls.test.ts`  | RLS context utilities and middleware                   |
| `user-context.test.ts`       | User context enrichment middleware                     |

## Conventions

- Use `describe` / `it` / `expect` from `bun:test`.
- Mock modules **before** importing the code under test.
- Keep tests deterministic and free of network/DB side effects.
