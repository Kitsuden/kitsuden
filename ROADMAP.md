# Roadmap

What Kitsuden does not do yet, in the order it is planned. Nothing here is promised
for a date. What is already done is listed at the end, with where it is documented.

## Open

### Agent safety and accountability

- **Customer data on the way out, what is left.** Sandbox `fetch`, `webhook_out`,
  notifications, model prompts and embeddings, the email tool and external MCP calls
  stop marked values, including base64, hex, digests and digits-only copies; realtime
  is a read with the subscriber's permissions ([egress](docs/agents/egress.md)). Still
  open: encryption, reversing, values split across requests, partial values, encodings
  nested twice, email sent by kon code, exports, and a realtime policy edited on another
  replica (it waits for the 30 s cache).
- **External MCP tools, what is left.** Agents call approved tools with an explicit
  `mcp-external:` scope and a fingerprint check on every call
  ([external MCP](docs/agents/external-mcp.md)). Still open: scheduled refresh, OAuth and
  SSE-only servers, DNS-rebinding pinning, and honoring the agent's wrap setting in
  engine runs.
- **Ledger follow-ups.** A webhook when a review is due (email is done). Evidence
  for writes in `direct` mode: done.

### Before 1.0

- **Drop the 0.8 block-key bridge (0.10).** 0.9 made the Inti contract English
  (`GET /api/version` keys, editorial routes and layer keys, stored block keys; `games` and
  `games-editorial` v2, with migrations). Remove the `// Remove in 0.10` read compatibility
  (`readBlockData`, `readEditorial` in `packages/shared/src/block-keys.ts` and their callers).
- **Panel views out of the panel.** Academy, blog, CRM, accounting, documents, games,
  newsletter, OCR and streamers views ship with the panel and appear only when their kon
  is installed. They should ship with their kons (kons repository) as Web Components.
- **Stable API promise.** A draft is in [api-stability](docs/api-stability.md); the owner
  decides what it covers and for how long.

### Packaging and getting started

- Publish `@kitsuden/*` (including `create-kitsuden`) to npm and the images to a
  registry, so an install does not compile. The packages are ready; publishing is the
  owner's step.

### Evidence

- Agent evaluation with a real model. The harness lives in the kons repository
  (`extras/from-core/apps/api/evals/agents-mcp`) and has to be repointed at the kons' MCP
  tools. It has only run with a perfect and a null agent.
- Independent security review of the agent layer.
- Load tests on a dedicated server, with a tuned pool, against another backend in the
  same scenario. The figures in `docs/agents/benchmarks.md` come from a busy laptop.
- Run the new macOS CI job and the Swift, Kotlin and Dart SDK tests: none has run yet
  (no toolchains on the development machine, and CI has not run since).

## Done

### Agent data ledger ([ledger](docs/agents/ledger.md))

- Per-field decisions: a proposal that writes a record shows a per-field diff, and a
  person accepts, rejects or edits each field.
- Evidence and source per field (`_evidence`), kept per row in `field_evidence` and
  returned in `_provenance.fields`.
- Jobs queued by an agent are charged to its daily budget when they run, and a decision
  can schedule a later review (Approvals → Reviews).

### Agent safety and accountability

1. External actions with state: `ctx.effect(key, fn)` in TypeScript actions and
   `kitsuden.effect(key, fn)` in panel-defined code actions run an effect at most once
   per key ([queue](docs/install/queue.md), [sandbox](docs/agents/sandbox.md)); outgoing
   webhooks send an `Idempotency-Key`.
2. Limit on what leaves: fields marked `sensitivity: "customer" | "personal"`
   ([egress](docs/agents/egress.md)).
3. Deny with an alternative: unattended runs can refuse a held write with
   `KITSUDEN_E_DENIED_UNATTENDED` and an `alternative` ([approvals](docs/agents/approvals.md)).
4. Versioned agents: `agent_versions`, every trace records the version that ran
   ([versions](docs/agents/versions.md)).
5. What an agent chose not to do: `kitsuden_record_decision`, Approvals → Discarded
   ([decisions](docs/agents/decisions.md)).
6. External MCP tools: fingerprints and human review ([external MCP](docs/agents/external-mcp.md)).

### Security hardening (review of 2026-11-03)

Panel CSP with hashes and no `unsafe-eval`; outbound calls pinned to the address they
checked (DNS rebinding); agents cannot change a code action's trigger; the limiter keys
unproven private addresses on the socket; no passwords on command lines; CI actions
pinned to SHAs; setup token and closed sign-up whenever the API listens beyond
loopback; `KITSUDEN_SECRETS_KEY` required in production (`scripts/rekey-secrets.ts`);
agent keys expire after 90 days by default; per-route body limits for media and
imports; realtime applies `publishedOrOwn`; kon admin assets limited to declared views;
an editor cannot approve their own agent's proposals; dead RLS helpers removed; MCP
hides 5xx detail in production. Details in `CHANGELOG.md`.

### Before 1.0 and packaging

- `data_sets.game_id` removed (migration 0073).
- `npm create kitsuden` (`packages/create-kitsuden`, not on npm yet), with an offline scaffold.
- A kon's typed client without a running API: `node scripts/sdk/generate.mjs --from-kon=<dir>`.
- A macOS CI job (typecheck, unit and CLI tests).

### Platform

- Two-factor sign-in and magic links; `KITSUDEN_ADMIN_MFA=required` for admins.
- Point-in-time restore (`KITSUDEN_PITR=on`) and a streaming replica
  ([high availability](docs/install/high-availability.md)).
- Swift, Kotlin and Dart SDKs (`packages/sdk-swift`, `sdk-kotlin`, `sdk-dart`).
