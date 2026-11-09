---
name: authorization-change
description: >-
  Change who can do what in the Kitsuden core: a route gate, a role, an agent scope, a policy or a
  row-security rule. Use when the user asks to open or close a route, add a scope, let an agent or
  editor do something, mount a new route, or a test fails in the authorization matrix, the admin
  gate or scope parity.
---

# Change authorization

Read first: `docs/agents/permissions.md` ("The rule: union, and deny wins", "Where each check
happens") and the header of `apps/api/src/middleware/authorization-matrix.ts` (the levels).

## Rules that must hold

- **Deny by default.** A route with no gate, or a policy action with no rule, is a bug.
  Policies are `definePolicy` / `can` in `@kitsuden/engine`.
- **Scopes are a union, and a deny wins** over every grant, `admin` included (`!kon:crm:*`).
  One implementation: `packages/shared/src/agent-permission.ts`, mirrored in SQL by
  `apps/api/src/db/agent-functions.sql`.
- **Scope shapes.** One kon operation: `kon:<kon>:<operation>`; a whole kon: `<kon>:*` (same as
  `kon:<kon>:*`); `<kon>` is the kon id without `kon-`. Datasets: `datasets:<slug>:read|write|delete`.
  Do not invent broad scopes; the list is in `docs/agents/permissions.md`.
- **Agents are not users.** In policies use `isEffectiveAdmin(u, "<kon>")`,
  `isEffectiveStaff(u, "<kon>")`, `agentCanInKon`, `actsAsUserIn("<kon>")`, never
  `user.role === "admin"`; in SQL the matching `kitsuden_effective_*` / `kitsuden_agent_can_in_kon`.
- **404, not 403, for a row the caller may not see**, so its existence does not leak (see
  `apps/api/src/routes/crud.ts` and `routes/approvals.ts`). A 403 is for a gate on a whole route.
- **Humans only** for approvals and OAuth consent: `HUMANS_ONLY` in `authorization-matrix.ts`;
  no agent scope opens them.

## Where to change it

| What                                                  | File                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Route gates (`requireRole`, `requireStaff`, prefixes) | `apps/api/src/middleware/auth-guard.ts` (`ADMIN_ONLY_ROUTES`, `SCOPE_CONTENT`, `requireScope`)                       |
| Agent key checks, denies                              | `apps/api/src/services/agent-auth.ts` (`hasScope`), `auth-guard.ts` (`agentDenials`)                                 |
| Operations                                            | the operation's `permission` (`defineOperation`, `@kitsuden/shared`), checked in `packages/engine/src/operations.ts` |
| Row security                                          | `apps/api/src/db/rls-policies.sql`, `rls-owned-tables.sql` (+ a migration if the table is new)                       |
| Who reaches each route                                | `MATRIX` in `apps/api/src/middleware/authorization-matrix.ts` (kons: their `authorization-matrix.kons.json`)         |

## Steps

1. Write a failing test first (a request as the identity that must be refused or allowed).
2. Change the gate, scope or policy. Change the TypeScript and SQL rule together, never one.
3. Classify every new or changed route in `MATRIX` with its level (`public`, `user`, `staff`,
   `content`, `admin`, `restricted`, `custom`). A public write needs a written reason.
4. Run the checks:
   ```bash
   pnpm exec vitest run --config=tests/unit/vitest.config.ts tests/unit/authorization-matrix.test.ts \
     tests/unit/admin-gate.test.ts tests/unit/agent-permission.test.ts tests/unit/scopes-parity.test.ts \
     tests/unit/whole-kon-gate.test.ts tests/unit/fresh-role-at-gates.test.ts
   pnpm test:api          # on the test database (pnpm test:db:up first)
   ```
   Without `KITSUDEN_MATRIX_DB` the matrix test only checks the table and its comparator. The
   full run (real app, every kon, real identities) needs a test database migrated with
   `--all-kons`; how to set it up is in the headers of `tests/unit/authorization-matrix.test.ts`
   and `apps/api/scripts/authorization-matrix.ts`. CI checks only the table and its comparator,
   so run the full matrix yourself after changing a gate.
5. Update `docs/agents/permissions.md` if a scope, gate or check changed.

Report who gains or loses access to what, and which tests ran. Do not commit unless asked.
