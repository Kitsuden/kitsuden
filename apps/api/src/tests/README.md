# Kitsuden API Tests

## Test Suites

### 1. Kon Registry Tests (`modules.test.ts`)

Tests for the kon registry system.

- Registry structure validation
- Category classification
- Dependency tracking
- Icon and color validation
- **Requires DB:** No

### 2. Auth Module Tests (`auth.test.ts`)

Tests for authentication and authorization.

- User registration
- User login
- Session management
- API key authentication
- **Requires DB:** Yes

### 3. Datasets Module Tests (`datasets.test.ts`)

Tests for dataset CRUD operations.

- Dataset creation
- Entry management
- Schema validation
- Concurrent operations
- **Requires DB:** Yes

### 4. Row Level Security Tests (`rls.test.ts`)

Tests for RLS context and tenant isolation.

- RLS context variables
- Data isolation
- RLS policies
- Transaction context
- **Requires DB:** Yes

## Running Tests

### Run all tests

```bash
cd apps/api
bun test
```

### Run specific test suite

```bash
bun test src/tests/modules.test.ts    # No DB required
bun test src/tests/auth.test.ts       # Requires DB
bun test src/tests/datasets.test.ts   # Requires DB
bun test src/tests/rls.test.ts        # Requires DB
```

### Run with coverage

```bash
bun test --coverage
```

## Database Setup for Tests

Tests that require a database need:

1. PostgreSQL with pgvector running
2. A test database whose name contains `test` (the suite deletes whole tables without a `WHERE`)
3. Environment variables set

### Quick Setup

The repository ships a test stack (Postgres on port 5434, Valkey on 6380). Its settings
come from `.env.test`, which is created from `.env.test.example`:

```bash
# From the repository root: start the test Postgres and Valkey
pnpm test:db:up

# Run migrations, then the tests (DATABASE_URL must point at the test database)
cd apps/api
bun run db:migrate
bun test src/tests/

# Stop the stack
pnpm test:db:down
```

### Environment Variables

```env
# .env.test
DATABASE_URL=postgres://kitsuden:<password>@127.0.0.1:5434/kitsuden_test
REDIS_URL=redis://127.0.0.1:6380
NODE_ENV=test
BETTER_AUTH_SECRET=change-me-to-a-random-string-at-least-32-chars
```

## Rollback per test (`rollback.ts`)

`itWithRollback(name, fn)` runs a test inside one transaction that is always
rolled back, instead of cleaning up with `clearTestData()` (`DELETE FROM` whole
tables). Measured in `rollback-per-test.test.ts`: 40 tests x 25 rows, 156 ms
with `DELETE` against 96 ms with `ROLLBACK` (local Docker).

What it covers: `repo()`, `theRequestDb()`, kons, the explicit `tx`, and a
request through `rlsTransaction` (the middleware reuses the test transaction).
What it does not: the global `db` used directly (another pool connection, it
commits). Do **not** use it in tests that check a real COMMIT: the request
transaction, the queue (`queue-postgres.test.ts`), or RLS with the request's own
user (pass the user to `itWithRollback` instead).

## Recent Additions

A focused test pass added coverage for core files that previously had 0% or very low line coverage:

- `src/tests-unit/logger.test.ts` — logger helpers (`createRequestLogger`, `createPerformanceLogger`, `logQuery`, `logSecurity`)
- `src/tests-unit/storage.test.ts` — S3/MinIO operations with mocked AWS SDK
- `src/tests-unit/config.test.ts` — config exports, feature flags, rate-limit and CORS configs
- `src/tests-unit/transactional-rls.test.ts` — RLS context utilities and middleware helpers
- `src/tests-unit/module-loader-unit.test.ts` — `createKonContext`, kon type guards, dependency sort
- `src/tests-unit/crud-routes.test.ts` — inline `dataSetsRoutes` handlers (GET/POST datasets and entries)
- `src/tests-unit/system-routes.test.ts` — inline `systemRoutes` handlers (theme activation, grimoire-state, grimoire deletion)
- `src/tests/system-routes-http.test.ts` — integration smoke tests for authenticated system routes (skips when DB unavailable)

These tests follow the existing `describe`/`it`/`expect` Bun style and reuse the mock patterns from the rest of the suite.

## Future Test Additions

### Priority 1

- [x] Middleware tests (auth-guard, transactional-rls)
- [x] API endpoint integration tests
- [x] Cache layer tests
- [ ] Queue/Worker tests

### Priority 2

- [ ] Kon loader tests
- [ ] MCP server tests
- [ ] Real-time/WebSocket tests
- [ ] File upload tests

### Priority 3

- [ ] Performance benchmarks
- [ ] Load tests
- [ ] End-to-end API tests
