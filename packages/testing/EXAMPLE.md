# Kitsuden Testing Framework - Usage Examples

## Basic Example

```typescript
// packages/kons/kon-blog/blog.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTestSandbox } from "@kitsuden/testing";

const sandbox = createTestSandbox({
  kons: ["kon-datasets", "kon-blog"],
  fixtures: {
    users: [
      { id: "admin-1", name: "Admin", role: "admin" },
      { id: "editor-1", name: "Editor", role: "editor" },
    ],
    categories: [{ id: "cat-1", name: "Tech", slug: "tech" }],
  },
});

beforeAll(() => sandbox.setup());
afterAll(() => sandbox.teardown());
afterEach(() => sandbox.reset());

describe("kon-blog", () => {
  describe("POST /api/blog/posts", () => {
    it("creates a post when authenticated", async () => {
      const response = await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
        title: "My First Post",
        content: "Hello World",
        categoryId: "cat-1",
      });

      expect(response.status).toBe(201);
      expect(response.body.title).toBe("My First Post");

      // Assert in database
      await sandbox.assert.database.has("posts", {
        title: "My First Post",
      });

      // Assert event was emitted
      sandbox.assert.events.emitted("blog:post:created");
    });

    it("returns 401 when not authenticated", async () => {
      const response = await sandbox.http.post("/api/blog/posts", {
        title: "Unauthorized Post",
      });

      expect(response.status).toBe(401);

      await sandbox.assert.database.missing("posts", {
        title: "Unauthorized Post",
      });
    });

    it("validates required fields", async () => {
      const response = await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
        // Missing title
        content: "No title here",
      });

      expect(response.status).toBe(400);
      expect(response.body.errors).toContainEqual(expect.objectContaining({ field: "title" }));
    });
  });

  describe("GET /api/blog/posts", () => {
    it("lists posts with pagination", async () => {
      // Create some posts
      for (let i = 0; i < 5; i++) {
        await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
          title: `Post ${i}`,
          content: `Content ${i}`,
        });
      }

      const response = await sandbox.http.get("/api/blog/posts?limit=3");

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.pagination.total).toBe(5);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe("Permissions", () => {
    it("allows admin to delete any post", async () => {
      // Create post as editor
      const post = await sandbox.http.asUser("editor-1").post("/api/blog/posts", {
        title: "Editor Post",
        content: "Content",
      });

      // Delete as admin
      const deleteRes = await sandbox.http
        .asUser("admin-1")
        .delete(`/api/blog/posts/${post.body.id}`);

      expect(deleteRes.status).toBe(204);
      await sandbox.assert.database.missing("posts", { id: post.body.id });
    });

    it("prevents editor from deleting others' posts", async () => {
      // Create post as admin
      const post = await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
        title: "Admin Post",
        content: "Content",
      });

      // Try delete as editor
      const deleteRes = await sandbox.http
        .asUser("editor-1")
        .delete(`/api/blog/posts/${post.body.id}`);

      expect(deleteRes.status).toBe(403);
      await sandbox.assert.database.has("posts", { id: post.body.id });
    });
  });
});
```

## Testing Events

```typescript
it("emits events on post lifecycle", async () => {
  // Clear previous events
  sandbox.events.clear();

  const response = await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
    title: "Event Test",
    status: "draft",
  });

  // Check events
  expect(sandbox.events.all).toHaveLength(2);

  sandbox.assert.events.emitted("blog:post:created", {
    postId: response.body.id,
  });

  sandbox.assert.events.emitted("blog:post:draft_saved");
});
```

## Testing with Fixtures

```typescript
// fixtures/blog-rich.ts
import { defineFixture } from "@kitsuden/testing";

export default defineFixture({
  id: "blog-rich",
  dependencies: ["users"],
  setup: async (ctx) => {
    // Use context to create data
    const posts = [];
    for (let i = 0; i < 10; i++) {
      const post = await ctx.db.insert("posts", {
        title: `Post ${i}`,
        slug: `post-${i}`,
        status: i % 2 === 0 ? "published" : "draft",
      });
      posts.push(post);
    }

    return { posts };
  },
});

// In test
const sandbox = createTestSandbox({
  kons: ["kon-blog"],
  fixtures: "blog-rich",
});

// Access fixture data
it("filters published posts", async () => {
  const publishedCount = sandbox.fixtures.posts.filter((p: any) => p.status === "published").length;

  const response = await sandbox.http.get("/api/blog/posts?status=published");

  expect(response.body.data).toHaveLength(publishedCount);
});
```

## Database Assertions

```typescript
it("creates audit log on update", async () => {
  const post = await createPost();

  await sandbox.http.asUser("admin-1").patch(`/api/blog/posts/${post.id}`, {
    title: "Updated Title",
  });

  // Multiple assertions
  await sandbox.assert.database.has("posts", {
    id: post.id,
    title: "Updated Title",
  });

  await sandbox.assert.database.count("audit_logs", 1, {
    entityType: "post",
    action: "update",
  });

  // Check old value preserved
  const audit = await sandbox.db.get("audit_logs", {
    entityId: post.id,
  });
  expect(audit.oldValues.title).toBe(post.title);
});
```

## Testing Multiple Kons

```typescript
const sandbox = createTestSandbox({
  kons: ["kon-datasets", "kon-blog", "kon-media", "kon-comments"],
  fixtures: "full-system",
});

it("integrates blog with comments and media", async () => {
  // Create post
  const post = await sandbox.http.asUser("admin-1").post("/api/blog/posts", {
    title: "Post with Media",
    featuredImageId: sandbox.fixtures.images[0].id,
  });

  // Add comment
  await sandbox.http.asUser("user-1").post(`/api/comments/posts/${post.body.id}`, {
    content: "Great post!",
  });

  // Verify all connected
  await sandbox.assert.database.has("posts", { id: post.body.id });
  await sandbox.assert.database.has("comments", { postId: post.body.id });

  // Get post with expanded relations
  const getRes = await sandbox.http.get(
    `/api/blog/posts/${post.body.id}?expand=comments,featuredImage`
  );

  expect(getRes.body.comments).toHaveLength(1);
  expect(getRes.body.featuredImage).toBeDefined();
});
```

## Using with Different Auth

```typescript
it("supports multiple auth strategies", async () => {
  // As user object
  await sandbox.http
    .asUser({ id: "1", name: "Test", role: "admin" })
    .post("/api/posts", { title: "Test" });

  // As user ID (looks up from fixtures)
  await sandbox.http.asUser("admin-1").post("/api/posts", { title: "Test 2" });

  // With bearer token
  await sandbox.http.withToken("test-token-123").post("/api/posts", { title: "Test 3" });
});
```

## Testing Error Cases

```typescript
it("handles database errors gracefully", async () => {
  // Simulate DB failure
  const originalInsert = sandbox.context.db.instance.insert;
  sandbox.context.db.instance.insert = () => {
    throw new Error("Connection lost");
  };

  const response = await sandbox.http.asUser("admin-1").post("/api/blog/posts", { title: "Test" });

  expect(response.status).toBe(500);
  expect(response.body.error).toContain("Error");

  // Restore
  sandbox.context.db.instance.insert = originalInsert;
});
```
