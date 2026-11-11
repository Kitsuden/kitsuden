# Engine, core and kons

Kitsuden is a backend built for AI agents, efficient and secure by default
(see the [README](README.md#why-kitsuden)). The agent and security pieces
(MCP, agent identities and scopes, audit, TOON, deny-by-default policies,
RLS) live in the engine and the host; everything domain-specific, content
included, is a kon you switch on.

Kitsuden has three levels of code. One question decides where a piece goes:

> **"Would every Kitsuden app want this, whatever its domain?"** → **core** (a battery).
> **"Is it a business or domain module?"** → **kon**.

`kon-games` is not the same kind of thing as the vault or the secrets
manager: the first is an app you build _on_ Kitsuden; the others are
batteries of the framework.

## Level 1 — Engine (`packages/engine/`)

Framework primitives, with no infrastructure and no domain. Both `apps/api`
and the kons import them through `@kitsuden/engine`.

| Module                      | What it is                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `authz`                     | deny-by-default policies and gates (`definePolicy`, `can`)                                                |
| `validation`                | request validation (`validateRequest`)                                                                    |
| `errors`                    | `AppError` and a uniform error envelope                                                                   |
| `repository`                | `repo()`, which picks up the request's RLS transaction automatically                                      |
| `request-scope`             | request-scoped context (AsyncLocalStorage)                                                                |
| `interceptors`              | onion-style interceptors, no decorators                                                                   |
| `mail`                      | mailables, interchangeable drivers (`smtp`, `resend`, `log`, `memory`), a test outbox and a shared layout |
| `brain`                     | knowledge base and tree index (retrieval by structure)                                                    |
| `code-graph`                | code intelligence (find, references, path)                                                                |
| `system-map`                | architecture self-mapping                                                                                 |
| `actions`, `query`, `batch` | automation and queries                                                                                    |
| `links`                     | polymorphic links **between** kons                                                                        |

```typescript
import { repo, definePolicy } from "@kitsuden/engine";

definePolicy<Game>("game", {
  view: (user, game) => game.status === "published" || user?.role === "admin",
  update: (user, game) => !!game.ownerId && game.ownerId === user?.id,
});

const games = await repo(gamesTable)
  .filter({ status: "published" })
  .orderBy("-createdAt")
  .paginate(1, 20);
```

## Level 2 — Kitsuden core (`packages/core/`)

The **batteries**: capabilities every app wants. They are their own packages,
loaded by the module loader before the kons, but they keep their manifest `id`
(`kon-datasets`…) as the stable key for configuration, the registry and the
database.

| Folder                | Package                   | What it is                                        |
| --------------------- | ------------------------- | ------------------------------------------------- |
| `datasets/`           | `@kitsuden/datasets`      | dynamic collections with an automatic REST API    |
| `media/`              | `@kitsuden/media`         | media library: local or S3 storage, image presets |
| `blocks/`             | `@kitsuden/blocks`        | the page builder                                  |
| `vector-search/`      | `@kitsuden/vector-search` | embeddings and semantic search (pgvector)         |
| `content-publishing/` | —                         | publishing utilities                              |

Some core capabilities live as **host services** (`apps/api/src/services/`)
because they are coupled to the runtime:

| Service                       | What it is                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Vault (`vault.ts`)            | dynamic schemas with real `CREATE TABLE`s and RLS; off unless `KITSUDEN_VAULT_ENABLED=true` |
| Secrets (`secrets.ts`)        | secrets manager, AES-256-GCM (`KITSUDEN_SECRETS_KEY`)                                       |
| GraphQL (`routes/graphql.ts`) | GraphQL API generated from the schema                                                       |

## Level 3 — Kons (installed, not part of the core)

**Domain** modules — a blog, a wiki, a CRM, tournaments… — are **not part of
the Kitsuden core**. They live in a separate repository,
[`kitsuden-kons`](https://github.com/Kitsuden/kitsuden-kons) (MIT), and are installed into a project with
`kitsuden kon add <name>`, which copies the kon to `packages/kons/<kon-id>/`
(git-ignored here) and declares it in `kitsuden.kons.json`. A fresh clone of
Kitsuden has no kon and is a complete backend for agents.

- **Installed** = declared in `kitsuden.kons.json` or `KITSUDEN_KONS`
  (`apps/api/src/lib/installed-kons.ts`); nothing is discovered by scanning a
  folder.
- **Active** = the `modules` table (the admin panel).
  `apps/api/kitsuden.config.ts` only seeds the defaults of installed kons.
- **Compatible** = the kon's `sdk` (in `kon.json`) is not newer than this
  core's `GET /api/version` → `sdk.kons`; otherwise it is not mounted.

What is core and what is a kon, with the reason for each:
[docs/kons/core-and-kons.md](docs/kons/core-and-kons.md). Installing:
[docs/kons/installing.md](docs/kons/installing.md). Writing one:
[docs/kons/README.md](docs/kons/README.md). Publishing one:
[docs/kons/publishing.md](docs/kons/publishing.md).

### Maturity

Every `kon.json` declares its maturity in the `"maturity"` field (the key name
is part of the manifest format), and the admin panel shows a badge next to the
toggle for anything that is not stable. The allowed values are:

- `stable` (stable): used end to end in real deployments.
- `beta`: works and has tests, but with gaps or little real use.
- `experimental`: code and tests exist, but nobody has run it end to end in
  production. Read the code before you rely on it.

The core modules:

| Kon            | `maturity` | Folder                   |
| -------------- | ---------- | ------------------------ |
| `kon-blocks`   | `stable`   | `packages/core/blocks`   |
| `kon-datasets` | `stable`   | `packages/core/datasets` |
| `kon-media`    | `stable`   | `packages/core/media`    |

The maturity of every installable kon is in the README of the kons repository
(generated from each `kon.json`) and in `kitsuden kon list --available`.
`tests/unit/kon-maturity.test.ts` fails if a core module or an installed kon
has no valid maturity, or if this table disagrees with the core manifests.

## Grimoires (`packages/grimoires/`)

Curated sets of kons plus theming. A grimoire declares in its
`grimoire.json` which kons it enables; activating it in the panel enables
them and, if it defines `config.theme`, changes the panel's look.

## What a kon can contribute

A kon brings more than routes and tables. It registers its own pieces in the
shared layers, without the host knowing about it:

| Contributes         | How                                         | Where                                           |
| ------------------- | ------------------------------------------- | ----------------------------------------------- |
| Routes              | `defineKon({ createRouter })`               | mounted at its `mountPath`                      |
| Tables              | the kon's schema and migrations             | applied by `apps/api/scripts/migrate.ts`        |
| Authorization       | `definePolicy("<resource>", …)`             | `<name>.policy.ts`                              |
| Emails              | `mail.register(mailable)` in `onStartup`    | `<name>.mails.ts`                               |
| Translations        | `mail.addTranslations(locale, …)`           | next to its emails                              |
| Admin views         | `admin.views` in `kon.json`                 | generated, or a Web Component loaded at runtime |
| Actions / MCP tools | `defineAction({ trigger: "agent.tool:…" })` | exposed automatically                           |

The rule for all of them: a kon imports from `@kitsuden/engine` and
`@kitsuden/shared`, **never** from `apps/api`. Everything else (database,
cache, events, auth, storage, logger) arrives through the injected
`KonContext`. A mailable's name is also its queue job name, so queueing one
needs no change to the host:

```ts
await emailQueue.add("crm.deal-won", { to, dealName, locale: "es" });
```

## Payments (`kon-payments`, in kitsuden-kons)

Four gateways behind one interface: **Stripe**, **Lemon Squeezy**, **Paddle**
and **PayPal**. It is a billing layer (subscriptions and checkout), not a
shop. It is **disabled by default** on purpose (`defaultEnabled: false`): a
kon that moves money must not switch itself on. Only providers whose keys
exist are enabled.

```
POST /api/payments/checkout            → payment URL
POST /api/payments/webhook/:provider   → public, authenticated by SIGNATURE
GET  /api/payments/subscription        → does this user have access?
```

Every gateway feeds one event stream. When `kon-conta` is installed too, the
stream can post double-entry entries to it (an optional integration, loaded at
runtime): set `PAYMENTS_LEDGER=true` plus `PAYMENTS_LEDGER_DEBIT_ACCOUNT` and
`PAYMENTS_LEDGER_CREDIT_ACCOUNT`. The accounts are required on purpose:
guessing them would produce wrong accounting, which is worse than none.

## Links between kons (`kitsuden_links`)

Foreign keys only work **inside** a kon. To say that a CRM contact, a player
and a member are the same person, the engine has polymorphic links:

```ts
import { link, neighbors, resolveNeighbors, unlinkAll } from "@kitsuden/engine";

await link(
  { type: "shop_orders", id: order.id },
  { type: "crm_contacts", id: contact.id },
  { relation: "ordered_by" }
);
const around = await neighbors({ type: "crm_contacts", id: contact.id });
```

> **If both sides live in the same kon, it is a foreign key. If they cross
> kons, it is a link.** `metadata` is for context (which channel, who
> confirmed it), never for fields someone will query.

The costs, and how they are paid:

- **No foreign keys.** Postgres cannot point at a target whose type is decided
  at runtime, so deleting a row leaves dangling edges. They are tolerated and
  filtered when resolving (if the loader does not return the row, the
  neighbour disappears). A clean kon calls `unlinkAll()` when it deletes.
- **RLS cannot follow the edge.** The links table is isolated by `owner_id`
  like the rest, and resolving the target always goes through the normal RLS
  of its table: you can see that an edge exists, but following it gives you
  nothing you could not already see.
- `resolveNeighbors` takes **one loader per type**, supplied by the caller. A
  type without a loader is skipped silently: it is a kon that is not
  installed.
- It works well with tens of edges per entity; with thousands, "everything
  about this person" gets slow and would need materialised views.

## Adding a module

- **A battery (every app wants it)?** → `packages/core/<name>/`, package
  `@kitsuden/<name>`, `kon.json` with `"core": true` and `"category": "core"`.
- **Domain?** → a kon, in a kons repository such as kitsuden-kons
  (`kons/kon-<name>/`, `"core": false`, with `sdk` and `mount.path` in its
  `kon.json`). `kitsuden make kon <name>` generates the skeleton (see
  `packages/cli/README.md`); move it to the kons repository and install it with
  `kitsuden kon add` ([docs/kons/publishing.md](docs/kons/publishing.md)).

The module loader resolves core modules from `packages/core/` and kons from
the installation (`kitsuden.kons.json` / `KITSUDEN_KONS`), both by the
manifest `id`.
