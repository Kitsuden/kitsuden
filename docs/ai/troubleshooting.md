# Kitsuden MCP Troubleshooting for AI Assistants

> **Purpose:** Structured error-to-recovery lookup for LLMs operating Kitsuden via MCP.  
> **Rule:** If a tool call fails, consult this doc before guessing.

---

## Error Index

| Error Pattern                                 | Root Cause                                                    | Recovery Tool / Action                                  |
| --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `Dataset not found` / `Dataset "x" not found` | Wrong UUID or slug; dataset never created                     | `kitsuden_list_datasets`                                |
| `RLS blocked the query` / `policy denied`     | Auth disabled or user lacks ownership                         | `kitsuden_enable_auth` + verify dataset policy          |
| `Kon not installed` / `module not found`      | Kon package missing or not registered                         | `kitsuden_install_kon`                                  |
| `Migration failed` / `SQL syntax error`       | Invalid DDL in kon migration or manual schema drift           | Check migration SQL, fix syntax, retry install          |
| `relation "kitsuden_outbox" does not exist`   | Migration 0056 (Postgres queue) not applied                   | `pnpm --dir apps/api db:migrate`                        |
| `Invalid API key` / `Unauthorized`            | Missing or expired `kitsuden_sk_*` / `kitsuden_agent_*` token | Regenerate token via `bun run seed:mcp`                 |
| `Entry not found` / `Record not found`        | Wrong entryId or record already deleted                       | Re-query with `kitsuden_query_dataset`                  |
| `Unknown tool: x`                             | Tool name typo or server version mismatch                     | Verify exact tool name in `docs/ai/tool-reference.json` |
| `Agent does not have MCP scope`               | NHI token lacks `mcp:connect` scope                           | Re-issue agent identity with correct scopes             |
| `Conflict` / `unique constraint`              | Duplicate slug, email, or key                                 | Change the conflicting field and retry                  |
| `Timeout` / `Worker did not respond`          | Background worker crashed or queue is full                    | Check worker logs, restart queue consumer               |

---

## Recovery Flows

### 1. "Dataset not found"

```
SYMPTOM:  kitsuden_query_dataset returns "Dataset 'projects' not found"
CAUSE:    You used a slug instead of a UUID, or the dataset was never created.
FIX:
  1. CALL kitsuden_list_datasets
  2. Inspect result for exact { id, slug, name }
  3. Use the UUID (id field) for all subsequent CRUD calls
  4. If the dataset is missing, decide:
     ├─ A kon covers this? → kitsuden_install_kon
     └─ Custom need? → kitsuden_create_dataset
```

---

### 2. "RLS blocked the query"

```
SYMPTOM:  Query returns empty set or "policy denied" even though records exist.
CAUSE:    The dataset has RLS enabled but no auth context is set, or the current
          user is not the owner of the rows.
FIX:
  1. CALL kitsuden_enable_auth({ methods: ["email"] })
     └─ Skip if auth is already enabled (check /api/health or admin UI).
  2. Verify the dataset policyJson includes an owner-only rule:
     { "rlsRules": [ { "field": "owner_id", "op": "eq", "value": "{{userId}}" } ] }
  3. If the user wants public read access, add a "published" status rule:
     { "rlsRules": [ { "field": "status", "op": "eq", "value": "published" } ] }
  4. Re-run the query.
```

---

### 3. "Kon not installed"

```
SYMPTOM:  Dataset expected by the kon is missing; kon routes 404.
CAUSE:    The kon package is not in node_modules or was not registered.
FIX:
  1. CALL kitsuden_install_kon({ konId: "kon-<name>" })
  2. WAIT for installation response (may include migration output).
  3. CALL kitsuden_list_datasets to verify new datasets appeared.
  4. If it still fails, check dependencies:
     └─ e.g., kon-games requires kon-media → install media first.
  5. If migration failed, see Flow 4.
```

---

### 4. "Migration failed"

```
SYMPTOM:  kon_install returns "Migration failed" or SQL syntax error.
CAUSE:    The kon's migration SQL has a syntax issue, or the core schema
          has drifted (e.g., a table was renamed manually).
FIX:
  1. Read the exact SQL error message from the tool response.
  2. Common fixes:
     ├─ "relation already exists" → kon was partially installed; skip migration, register manually.
     ├─ "column does not exist" → core schema is outdated; restart API to trigger auto-migrations.
     └─ "syntax error at or near" → fix the migration file in packages/kons/<name>/ and retry.
  3. If the kon is from npm, open an issue; do NOT edit npm packages inline.
  4. After fix, re-run kitsuden_install_kon.
```

---

### 5. "kitsuden_outbox does not exist" / jobs never run

```
SYMPTOM:  kitsuden_dispatch_worker fails, or jobs stay pending forever.
CAUSE:    The queue lives in Postgres (table kitsuden_outbox, migration 0056).
          Either the migration was not applied or no process runs the worker.
FIX:
  1. CHECK: GET /api/health → checks.queue.details (worker, waiting, dead)
  2. IF the table is missing: pnpm --dir apps/api db:migrate
  3. IF worker = "stopped": the API was started with QUEUE_WORKER=false
     (enqueue-only); start one process without it.
  4. IF dead > 0: GET /api/admin/queue lists the dead letters with their last
     error; POST /api/admin/queue/<id>/retry re-queues one.
```

---

### 6. "Invalid API key" / "Unauthorized"

```
SYMPTOM:  Any MCP call returns 401 or "Invalid API key".
CAUSE:    Token missing, wrong format, expired, or not hashed in DB.
FIX:
  1. VERIFY token format:
     ├─ Agent NHI (recommended):  kitsuden_agent_xxx
     └─ Legacy API keys (deprecated): kitsuden_sk_xxx
  2. IF token is missing from env:
     └─ Run: bun run apps/api/scripts/seed-mcp-test.ts
     └─ Copy token from progress.txt into env/KITSUDEN_API_TOKEN.
  3. IF token expired:
     └─ Regenerate in Admin → API Keys or Agent Identities.
  4. IF agent NHI:
     └─ Verify scopes include mcp:connect and required dataset scopes.
```

---

### 7. "Entry not found"

```
SYMPTOM:  kitsuden_update_record or kitsuden_delete_record returns "Entry not found".
CAUSE:    The entryId was deleted, never existed, or RLS hides it.
FIX:
  1. CALL kitsuden_query_dataset on the same dataset with limit 100.
  2. IF the entry is visible → you used the wrong ID; copy the correct one.
  3. IF the entry is NOT visible → check auth / RLS (see Flow 2).
  4. IF the entry was deleted → inform the user; offer to recreate.
```

---

### 8. "Unknown tool"

```
SYMPTOM:  MCP server responds "Unknown tool: kitsuden_X".
CAUSE:    Typo, or the server version does not expose that tool.
FIX:
  1. CHECK exact spelling against docs/ai/tool-reference.json.
  2. IF the tool is new (e.g., kitsuden_generate_frontend_hook):
     └─ The server may need an update. Use kitsuden_api_request as escape hatch.
  3. IF connecting via standalone MCP server (port 3002):
     └─ Tool names differ slightly (kitsuden_query_table vs kitsuden_query_dataset).
     └─ Prefer the native API MCP endpoint (/api/mcp) for full tool coverage.
```

---

## Preventive Checklist (Run Before Complex Operations)

- [ ] `kitsuden_list_datasets` — confirm target dataset exists and note its UUID.
- [ ] `kitsuden_list_datasets` — check if a kon already covers the domain.
- [ ] Auth enabled? If dataset has RLS, ensure `kitsuden_enable_auth` was called.
- [ ] Dependencies satisfied? If installing a kon, install upstream kons first.
- [ ] Valkey running? If dispatching workers, verify queue health.
- [ ] Need JSON for code? Results default to the shortest lossless format (`auto`); pass `format: "json"` to force compact JSON.
