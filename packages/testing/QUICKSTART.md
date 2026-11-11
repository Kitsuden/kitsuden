# Quickstart - Testing with Bun + Drizzle + Hono

## 1. Setup (1 minute)

`@kitsuden/testing` is not on npm yet: use it from a clone of Kitsuden, as a
workspace package.

```bash
# From the repository root: install, and build the testing package once
pnpm install --frozen-lockfile
pnpm --filter @kitsuden/testing build
```

In your kon (for example `packages/kons/kon-blog/package.json`), depend on the
workspace copy and install again:

```json
{ "devDependencies": { "@kitsuden/testing": "workspace:*", "pg-mem": "^3.0.14" } }
```

```bash
pnpm install
```

Once the package is published, `bun add -d @kitsuden/testing` will do the same
outside the monorepo.

## 2. Write a test (3 minutes)

```typescript
// packages/kons/kon-blog/blog.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createDrizzleSandbox } from "@kitsuden/testing/sandbox-drizzle";
import { postsTable, usersTable } from "./schema";

// Create a sandbox with REAL Drizzle
const sandbox = await createDrizzleSandbox({
  kons: ["kon-blog"],
  database: "pg-mem", // In-memory PostgreSQL (fast)
  schema: { postsTable, usersTable },
  fixtures: {
    admin: { id: "admin-1", email: "admin@test.com", role: "admin" },
  },
});

beforeAll(() => sandbox.setup());
afterAll(() => sandbox.teardown());
afterEach(() => sandbox.reset());

describe("Blog Kon", () => {
  describe("POST /api/blog/posts", () => {
    it("creates post via Hono, stores via Drizzle", async () => {
      // 1. Call the Hono endpoint
      const response = await sandbox.http.asUser(sandbox.fixtures.admin).post("/api/blog/posts", {
        title: "Hello Bun!",
        content: "Testing with real Drizzle",
        status: "published",
      });

      // 2. Check the HTTP response
      expect(response.status).toBe(201);
      expect(response.body.title).toBe("Hello Bun!");
      expect(response.body.slug).toBe("hello-bun");

      // 3. Check the REAL database with Drizzle
      const posts = await sandbox.drizzle
        .select()
        .from(postsTable)
        .where(eq(postsTable.title, "Hello Bun!"));

      expect(posts).toHaveLength(1);
      expect(posts[0].content).toBe("Testing with real Drizzle");
      expect(posts[0].status).toBe("published");

      // 4. Check the emitted event
      sandbox.assert.events.emitted("blog:post:created", {
        postId: response.body.id,
      });
    });

    it("validates with Zod before Drizzle", async () => {
      const response = await sandbox.http.asUser(sandbox.fixtures.admin).post("/api/blog/posts", {
        // title is missing (required by Zod)
        content: "No title",
      });

      expect(response.status).toBe(400);

      // Nothing should be in the database
      const posts = await sandbox.drizzle.select().from(postsTable);

      expect(posts).toHaveLength(0);
    });
  });

  describe("GET /api/blog/posts", () => {
    it("queries real data from Drizzle", async () => {
      // Insert data directly with Drizzle
      await sandbox.drizzle.insert(postsTable).values([
        { title: "Post 1", slug: "post-1", status: "published" },
        { title: "Post 2", slug: "post-2", status: "draft" },
        { title: "Post 3", slug: "post-3", status: "published" },
      ]);

      // Query through the Hono endpoint
      const response = await sandbox.http.get("/api/blog/posts?status=published");

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].status).toBe("published");
    });
  });

  describe("Drizzle Relations", () => {
    it("resolves author relation", async () => {
      // Create a user
      const [author] = await sandbox.drizzle
        .insert(usersTable)
        .values({ email: "author@test.com", name: "Author" })
        .returning();

      // Create a post with a relation
      await sandbox.drizzle.insert(postsTable).values({
        title: "With Author",
        slug: "with-author",
        authorId: author.id,
      });

      // Query with a join
      const result = await sandbox.drizzle.query.postsTable.findFirst({
        where: eq(postsTable.slug, "with-author"),
        with: {
          author: true, // Auto-join with Drizzle
        },
      });

      expect(result?.author.name).toBe("Author");
    });
  });

  describe("Transactions", () => {
    it("rolls back on error", async () => {
      await sandbox.transaction(async (tx) => {
        // Insert inside the transaction
        await tx.insert(postsTable).values({
          title: "In Transaction",
          slug: "in-transaction",
        });

        // Check that it exists inside the transaction
        const inTx = await tx.select().from(postsTable);
        expect(inTx).toHaveLength(1);

        // Automatic rollback at the end
      });

      // Check that it does NOT exist outside the transaction
      const outside = await sandbox.drizzle.select().from(postsTable);
      expect(outside).toHaveLength(0);
    });
  });
});
```

## 3. Run

```bash
# With Bun (native)
bun test blog.test.ts

# Watch mode
bun test --watch blog.test.ts

# With a real PostgreSQL (slower but more realistic)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5434/kitsuden_test \
  bun test blog.test.ts
```

## 4. Available APIs

### `sandbox.drizzle` - Real Drizzle ORM

```typescript
// Select
const posts = await sandbox.drizzle
  .select()
  .from(postsTable)
  .where(eq(postsTable.status, "published"));

// Insert
const [newPost] = await sandbox.drizzle.insert(postsTable).values({ title: "New" }).returning();

// Update
await sandbox.drizzle
  .update(postsTable)
  .set({ status: "archived" })
  .where(eq(postsTable.id, postId));

// Delete
await sandbox.drizzle.delete(postsTable).where(eq(postsTable.id, postId));

// Relations
const postWithAuthor = await sandbox.drizzle.query.postsTable.findFirst({
  where: eq(postsTable.id, postId),
  with: { author: true, comments: true },
});
```

### `sandbox.http` - HTTP client for Hono

```typescript
// Authentication
await sandbox.http.asUser("admin-1").get("/api/posts");
await sandbox.http.asUser({ id: "1", role: "admin" }).post("/api/posts", {...});
await sandbox.http.withToken("jwt-token").patch("/api/posts/1", {...});

// HTTP methods
await sandbox.http.get("/api/posts?status=published");
await sandbox.http.post("/api/posts", { title: "New" });
await sandbox.http.patch("/api/posts/1", { title: "Updated" });
await sandbox.http.put("/api/posts/1", { title: "Replaced" });
await sandbox.http.delete("/api/posts/1");
```

### `sandbox.assert` - Assertions

```typescript
// Database
await sandbox.assert.database.has("posts", { id: "123" });
await sandbox.assert.database.missing("posts", { id: "999" });
await sandbox.assert.database.count("posts", 5, { status: "published" });

// Events
sandbox.assert.events.emitted("blog:post:created");
sandbox.assert.events.emitted("blog:post:created", { postId: "123" });
sandbox.assert.events.notEmitted("blog:error");
```

### `sandbox.transaction()` - Isolated transactions

```typescript
await sandbox.transaction(async (tx) => {
  // Everything here is rolled back at the end
  await tx.insert(postsTable).values({...});
  const posts = await tx.select().from(postsTable);
});
```

## 5. Database strategies

### Option A: pg-mem (recommended for CI and unit tests)

```typescript
const sandbox = await createDrizzleSandbox({
  database: "pg-mem",
  schema: { postsTable },
});
// Fast (<50ms per test), no Docker
```

### Option B: real PostgreSQL with transactions

```typescript
const sandbox = await createDrizzleSandbox({
  database: "postgres",
  databaseUrl: process.env.TEST_DATABASE_URL,
  schema: { postsTable },
});
// Slower, but 100% real behavior
```

## 6. Fixtures

```typescript
// fixtures/blog-rich.ts
export default {
  users: [
    { id: "admin-1", email: "admin@test.com", role: "admin" },
    { id: "editor-1", email: "editor@test.com", role: "editor" }
  ],
  posts: [
    { id: "post-1", title: "Published", status: "published" },
    { id: "post-2", title: "Draft", status: "draft" }
  ]
};

// En test
const sandbox = await createDrizzleSandbox({
  kons: ["kon-blog"],
  schema: { postsTable, usersTable },
  fixtures: {
    users: [...],
    posts: [...]
  }
});

// Access
await sandbox.http.asUser(sandbox.fixtures.users[0]).post(...);
```

## Problems?

```bash
# Error: Cannot find module
bun run build  # in packages/testing

# Error: pg-mem not found
bun add -d pg-mem

# Error: database connection
# Make sure PostgreSQL is running when you use the "postgres" strategy
docker compose up db
```
