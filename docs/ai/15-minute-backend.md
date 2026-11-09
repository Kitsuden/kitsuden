# Backend in 15 Minutes — Kitsuden Demo

> **Prerequisite:** Node.js, Bun, pnpm and Docker Desktop installed.  
> **Goal:** Go from zero to a working backend with auth, database, admin panel, and typed frontend hooks.
>
> **Note:** the `kitsuden` CLI is **not published on npm**, so `npx kitsuden`
> does not work. Build it from the Kitsuden repository
> (`pnpm --filter @kitsuden/cli build`) and run `pnpm kitsuden`;
> this page calls it `kitsuden`. Only `kitsuden new` and `kitsuden make` are
> tested (`packages/cli/README.md`); the other commands used here are
> experimental. For a tested installation, follow `docs/install/`.

---

## Minute 0–2: Initialize

```bash
kitsuden init my-app --template blog
```

**What happens:**

- Creates `my-app/` with a Docker Compose file for the infrastructure (Postgres; Valkey behind `--profile replicas`), a `.env` with generated secrets, `kitsuden.config.ts`, `grimoire.json` and a README that explains how to run the API from a checkout
- Template `blog`: `kon-auth` + `kon-datasets` + `kon-media` + `kon-blog`

```bash
cd my-app
```

---

## Minute 2–5: Start Services

```bash
docker compose up -d        # Postgres, on 127.0.0.1 only
```

Then follow the generated `README.md`: clone Kitsuden, copy the project's `.env`
to `apps/api/.env`, migrate as the database superuser and start the API
(`bun run dev` in `apps/api`). The admin panel runs from the checkout with
`pnpm dev:admin`.

**Verify:**

```bash
curl http://localhost:3000/api/health
```

---

## Minute 5–7: Enable Auth (Optional but Recommended)

**Email/password** is already enabled by default. Add Google OAuth:

```bash
kitsuden auth add google \
  --client-id YOUR_GOOGLE_CLIENT_ID \
  --client-secret YOUR_GOOGLE_CLIENT_SECRET
```

Restart the API so it picks the provider up.

---

## Minute 7–10: Create Data (Two Ways)

### Way A — Via Admin UI

1. Open the admin panel (`pnpm dev:admin`; http://localhost:5173 by default)
2. Complete the first-run setup to create the initial admin (see `docs/install/first-run.md`)
3. Go to **Blog Posts** → **New Post**
4. Write title, content, tags, SEO meta

### Way B — Via API / MCP

Describe the collection first (MCP tool `kitsuden_describe_collection`) so the
payload matches its schema, then create the record with an agent key:

```bash
curl -X POST http://localhost:3000/api/items/blog-posts \
  -H "Authorization: Bearer $KITSUDEN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Hello Kitsuden",
    "slug": "hello-kitsuden",
    "status": "published",
    "excerpt": "My first post"
  }'
```

---

## Minute 10–13: Generate Frontend Code

```bash
# Types + React hooks + components for one collection
curl -X POST http://localhost:3000/api/generate-code \
  -H "Authorization: Bearer $KITSUDEN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "collection": "blog-posts", "framework": "react", "type": "all" }'

# Response: { collection, framework, files: [{ filename, content, language }] }
```

`framework` is `react`, `vue` or `svelte`; `type` is `hook`, `component`,
`form`, `types` or `all`. The same generator is the MCP tool
`kitsuden_generate_frontend_hook`.

For a typed client of the whole API instead, run
`kitsuden generate-sdk --output ./src/lib/kitsuden-sdk --base-url http://localhost:3000/api`.

**Copy the generated files into your frontend project.**

---

## Minute 13–15: Wire It Up

In your React/Vue/Svelte app, import what was generated. For example, with
React (the file and hook names come from the generated `files`):

```tsx
import { useBlogPosts } from "./sdk/blog-posts/useBlogPosts";
import { BlogPostList } from "./sdk/blog-posts/BlogPostList";

export default function BlogPage() {
  const { posts, loading, error } = useBlogPosts({ status: "published" });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <BlogPostList posts={posts} />;
}
```

**Done.** You now have:

- Auth (email + optional OAuth)
- Database (PostgreSQL with RLS)
- Admin panel
- REST API (http://localhost:3000/api)
- Typed frontend code
- MCP server for AI agents (`http://localhost:3000/api/mcp`)

---

## Next Steps

```bash
# Deploy to Railway
kitsuden deploy --provider railway

# Or add more features
kitsuden kon add booking    # appointment scheduling
kitsuden kon add crm        # contacts & pipelines

# Or let Cursor/Claude do it via MCP
kitsuden mcp --ide cursor
```

---

## Troubleshooting

| Problem                        | Solution                                            |
| ------------------------------ | --------------------------------------------------- |
| Port 3000 already in use       | Edit `.env` → change `API_PORT=3002`                |
| Database connection failed     | Wait 10s for Postgres to start, then restart API    |
| Auth redirect fails            | Check `BETTER_AUTH_URL` matches your localhost port |
| Generated code has wrong types | Generate it again after schema changes              |
