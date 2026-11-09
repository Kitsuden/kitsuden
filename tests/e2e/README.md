# 🎯 E2E Tests: MCP + Vector Search Integration

Integration tests for the flow from an MCP client through the MCP server to per-dataset vector search.

> **Status:** these tests are not run in CI. They expect `POST /api/datasets/:id/vector-search`
> and the `vectorSearch` dataset extension, which the API does not mount today (see
> `packages/core/vector-search/README.md`). Treat them as a specification of the intended flow.

## 📁 Structure

```
tests/e2e/
├── mcp-vector-search.e2e.spec.ts   # Main test suite
├── blog/editor-seo.e2e.spec.ts     # Blog editor SEO flows
├── playwright.e2e.config.ts        # Playwright config
├── global-setup.ts                 # Start API, seed data
├── global-teardown.ts              # Cleanup
└── README.md                       # This file
```

## 🔧 Prerequisites

```bash
# 1. PostgreSQL running
# 2. API dependencies installed
cd apps/api && bun install

# 3. Environment variables
export DATABASE_URL="postgresql://..."
export API_URL="http://localhost:3001"
export TEST_MCP_TOKEN="kitsuden_agent_..."  # From seed script
```

## ▶️ Running Tests

```bash
# Start database and API
docker compose up -d postgres
bun run apps/api/src/index.ts

# Seed test data (creates a test agent with a token)
bun run apps/api/scripts/seed-mcp-test.ts

# Run E2E tests
cd tests/e2e
npx playwright test --config=playwright.e2e.config.ts

# Or with environment
TEST_MCP_TOKEN=kitsuden_agent_xxx npx playwright test
```

## 📋 Test Scenarios

### Scenario 1: Semantic FAQ search

- The client asks natural language questions
- MCP routes to `kitsuden_search_entries`
- Vector search finds semantically similar entries
- Results returned to the client

### Scenario 2: Vector Index Status

- The client checks dataset configuration
- Verifies vector search is enabled

### Scenario 3: Add & Search Knowledge

- The client creates a new FAQ entry via MCP
- Entry automatically indexed (autoIndex: true)
- The client searches and finds the new entry

### Scenario 4: Error Handling

- Invalid dataset ID
- Empty queries
- Missing authentication

## 🔐 Security Tests

- Token validation (401 on missing token)
- Scope verification (403 on insufficient scopes)
- Session isolation (no cross-session access)

## 📝 Environment Variables

| Variable         | Description           | Default                 |
| ---------------- | --------------------- | ----------------------- |
| `API_URL`        | Base URL for API      | `http://localhost:3001` |
| `DATABASE_URL`   | PostgreSQL connection | -                       |
| `TEST_MCP_TOKEN` | Agent token from seed | -                       |
| `SKIP_SEED`      | Skip seed script      | `false`                 |
