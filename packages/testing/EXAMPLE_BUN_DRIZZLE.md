# Testing with Bun + Drizzle + Hono

Since Kitsuden uses **Bun** as runtime, **Drizzle ORM** for database, and **Hono** for API, here's the optimal testing setup:

## Option 1: Bun Test Runner (Recommended)

Bun has a built-in test runner that's faster than Vitest for Bun projects.

```typescript
// packages/kons/kon-blog/blog.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createTestSandbox } from "@kitsuden/testing/bun";

const sandbox = await createTestSandbox({
  kons: ["kon-blog"],
  database: "postgres", // Uses real PostgreSQL with transactions
  fixtures: {
    users: [{ id: "admin-1", email: "admin@test.com", role: "admin" }],
  },
});

beforeAll(() => sandbox.setup());
afterAll(() => sandbox.teardown());
afterEach(() => sandbox.reset());

describe("kon-blog", () => {
  it("creates post with Drizzle ORM", async () => {
    const response = await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
      title: "Test Post",
      content: "Content",
    });

    expect(response.status).toBe(201);

    // Real Drizzle query
    const posts = await sandbox.context.db.instance
      .select()
      .from(postsTable)
      .where(eq(postsTable.title, "Test Post"));

    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("test-post");
  });
});

// Run: bun test blog.test.ts
```

## Option 2: Drizzle with pg-mem (Fastest)

For unit tests that don't need real PostgreSQL:

```typescript
import { describe, it, expect } from "bun:test";
import { createDrizzleTestDb } from "@kitsuden/testing/drizzle";
import { postsTable } from "./schema";

// Create in-memory PostgreSQL
const { db, cleanup, transaction } = await createDrizzleTestDb({
  strategy: "memory",
  schema: { postsTable },
});

// Each test runs in isolated transaction
it("creates post", async () => {
  await transaction(async (tx) => {
    // Use real Drizzle ORM
    const [post] = await tx
      .insert(postsTable)
      .values({ title: "Test", content: "Content" })
      .returning();

    expect(post.title).toBe("Test");

    // Query it back
    const found = await tx.select().from(postsTable).where(eq(postsTable.id, post.id));

    expect(found).toHaveLength(1);
  });
});

// Cleanup after all tests
await cleanup();
```

## Option 3: Real PostgreSQL with Transactions

For integration tests:

```typescript
import { createDrizzleTestDb } from "@kitsuden/testing/drizzle";

const { db, transaction } = await createDrizzleTestDb({
  strategy: "postgres",
  connectionString: process.env.TEST_DATABASE_URL,
  schema: { postsTable, usersTable },
});

// Each test in transaction that rolls back
it("creates post with relations", async () => {
  await transaction(async (tx) => {
    // User
    const [user] = await tx.insert(usersTable).values({ email: "test@test.com" }).returning();

    // Post with relation
    const [post] = await tx
      .insert(postsTable)
      .values({
        title: "Test",
        authorId: user.id, // Real foreign key
      })
      .returning();

    // Query with relations (Drizzle syntax)
    const result = await tx.query.postsTable.findFirst({
      where: eq(postsTable.id, post.id),
      with: {
        author: true, // Auto-joined
      },
    });

    expect(result?.author.email).toBe("test@test.com");
  });
  // Transaction rolls back automatically
});
```

## Testing Hono Routes Directly

```typescript
import { Hono } from "hono";
import { describe, it, expect } from "bun:test";

// Your kon router
const app = new Hono();
app.get("/api/posts", async (c) => {
  const posts = await db.select().from(postsTable);
  return c.json({ data: posts });
});

// Test with Bun's native fetch
it("returns posts", async () => {
  const req = new Request("http://localhost/api/posts");
  const res = await app.fetch(req);

  expect(res.status).toBe(200);

  const json = await res.json();
  expect(json.data).toBeArray();
});

// Or use the sandbox HTTP client
it("returns posts (via sandbox)", async () => {
  const response = await sandbox.http.get("/api/blog/posts");

  expect(response.status).toBe(200);
  expect(response.body.data).toBeArray();
});
```

## Svelte Components (if needed)

If you need to test Svelte components in the admin:

```typescript
import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/svelte";
import PostEditor from "./PostEditor.svelte";

it("renders post editor", () => {
  const { getByText } = render(PostEditor, {
    props: { post: { title: "Test" } },
  });

  expect(getByText("Test")).toBeTruthy();
});
```

## Complete Example with YOUR Stack

```typescript
// kon-blog.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestSandbox } from "@kitsuden/testing/bun";
import { postsTable } from "./schema";

// Setup with YOUR stack
const sandbox = await createTestSandbox({
  kons: ["kon-blog"],
  database: "postgres", // Real PostgreSQL with transactions
  fixtures: {
    admin: { id: "1", email: "admin@test.com", role: "admin" },
  },
});

beforeAll(() => sandbox.setup());
afterAll(() => sandbox.teardown());

describe("Blog API", () => {
  it("creates via Hono, stores via Drizzle", async () => {
    // Hono HTTP call
    const res = await sandbox.http.asUser(sandbox.fixtures.admin).post("/api/blog/posts", {
      title: "Hello Bun!",
      content: "Testing with Bun + Drizzle + Hono",
    });

    expect(res.status).toBe(201);

    // Verify with real Drizzle query
    const posts = await sandbox.context.db.instance
      .select()
      .from(postsTable)
      .where(eq(postsTable.title, "Hello Bun!"));

    expect(posts[0].content).toBe("Testing with Bun + Drizzle + Hono");
  });
});

// Run: bun test
```

## Performance Comparison

| Strategy                  | Speed      | Isolation   | Setup      |
| ------------------------- | ---------- | ----------- | ---------- |
| `pg-mem`                  | 🟢 Fastest | ⚠️ Snapshot | None       |
| `postgres` (transactions) | 🟡 Fast    | ✅ Full     | PostgreSQL |
| Full Docker               | 🔴 Slow    | ✅ Full     | Docker     |

## Recommended Setup

```bash
# 1. Install dependencies. @kitsuden/testing is not on npm yet: inside the Kitsuden
#    workspace, add "@kitsuden/testing": "workspace:*" and "pg-mem" to your kon's
#    devDependencies and run `pnpm install` (see QUICKSTART.md). Once it is published:
#    bun add -d @kitsuden/testing pg-mem

# 2. Add to package.json scripts
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch",
    "test:db": "TEST_DATABASE_URL=postgres://... bun test"
  }
}

# 3. Environment variables
# .env.test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/kitsuden_test
```

## Key Points

1. **Bun's test runner** is native and fastest for your stack
2. **pg-mem** gives you real PostgreSQL behavior without Docker
3. **Drizzle ORM** queries work exactly like in production
4. **Hono routers** tested via native `fetch()`
5. **Transactions** ensure test isolation and fast cleanup
