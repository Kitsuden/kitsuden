# Publishing a kon

A kon is published as a folder in a **kons repository** — the official one is
[kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons) — and
installed with `kitsuden kon add <name> --from <repo>`. Writing the kon itself
(the operation SDK, policies, migrations) is in [README.md](README.md).

## Layout

```
my-kons/
  kons/
    kon-recipes/
      kon.json          id, name, version, sdk, maturity, mount.path, tables, dependencies
      package.json      @scope/kon-recipes; peers: hono, drizzle-orm, zod
      tsconfig.json     "extends": "../../tsconfig.kons.json"
      index.ts          export const kon = defineKonSdk({ … })
      migrations/       0001_*.sql — the ONLY place tables are created
  tsconfig.kons.json
  package.json          the workspace root (links the core, see below)
```

## The manifest (`kon.json`)

Required for a kon to be installable, and checked by the guards of
kitsuden-kons (`tests/guards/`):

| Field               | Why                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `kon-<name>`. The key of the kon everywhere: config, `modules` table, folder.                                                                                                                                         |
| `version`           | Shown by `kitsuden kon list`, recorded at install.                                                                                                                                                                    |
| `sdk`               | The kon SDK version it is written for. Kitsuden compares it with `GET /api/version` → `sdk.kons` **before** importing the kon and refuses newer ones, at install and at startup.                                      |
| `maturity`          | Maturity: `stable`, `beta` or `experimental`. What the panel and the README tell users. Be honest; it is about real use, not features.                                                                                |
| `mount.path`        | Where it is mounted (`/api/recipes`). It must equal the `mountPath` in the code: an installed but inactive kon is reserved at that path so it can be switched on without a restart.                                   |
| `tables`            | Every table it owns; each must be created by one of its migrations.                                                                                                                                                   |
| `dependencies.kons` | Other kons it needs (`kitsuden kon add` installs them too; the Docker build refuses to continue without them). Optional integrations go in `dependencies.optionalKons` and are imported at runtime, never statically. |

## Dependencies (`package.json`)

- `hono`, `drizzle-orm` → **peerDependencies**: the kon must use the API's
  copies (a second copy of the engine turns its 404s into 500s; a second
  drizzle has its own classes).
- `zod` → **not declared**: import it from the engine,
  `import { z } from "@kitsuden/engine/zod"` (one Zod version for the whole
  monorepo; `eslint` rejects `from "zod"` inside `packages/kons`).
- a heavy library only some installs need (an LLM SDK, a PDF or OCR engine) →
  **optional** peer (`peerDependenciesMeta: { "x": { "optional": true } }`),
  imported with `await import("x")` where it is used, so a kon without it still
  loads. The core does the same with its LLM SDKs, PGlite, `nodemailer` and
  `pdf-lib`.
- `@kitsuden/shared`, `@kitsuden/engine` → **not declared**: the host provides
  them. Compatibility is the `sdk` field.
- another kon → peer `"@kitsuden/kon-x": "workspace:*"` plus
  `dependencies.kons` in `kon.json`. Never `import "../kon-x/…"`: with the other
  kon not installed, yours does not compile.
- anything else the kon alone uses → normal `dependencies`.

## Loading: only active kons are imported

The API imports a kon's code only if it is **enabled** (the `modules` table,
set from the panel, seeded from `kitsuden.kons.json`). An installed but
disabled kon is not imported at startup: its mount path is reserved and the
kon is imported the first time it is enabled and called
(`apps/api/src/lib/deferred-kons.ts`). So an installed kon costs nothing until
someone turns it on.

## Building and testing against Kitsuden

Kons are type-checked and tested against a checkout of Kitsuden linked at
`./.kitsuden` (fixed name, so the lockfile is the same everywhere):

```bash
KITSUDEN_DIR=../kitsuden node scripts/link-core.mjs
pnpm install && pnpm build && pnpm test
```

The root `package.json` of the kons repository links `@kitsuden/shared`,
`@kitsuden/engine`, `hono`, `drizzle-orm`, `zod` and the test toolchain from
`.kitsuden` (`link:` dependencies). The CI of
kitsuden-kons checks out Kitsuden into `.kitsuden`, installs it, and then runs
the kon type-checks, the tests, the guards and **every kon's migrations on a
real Postgres with Kitsuden's own runner**. Copy that workflow
(`.github/workflows/ci.yml`) for your own kons repository.

`@kitsuden/shared` and `@kitsuden/engine` are not published to npm yet. When they
are, the links become version ranges; the kons themselves do not change.

## Releasing

There is no public registry for kons yet (see [registry.md](registry.md) for the
signed-registry mechanism you can host yourself): a release is a git tag of the
kons repository. Users pin it with

```bash
kitsuden kon add recipes --from https://github.com/acme/kons.git --ref v1.2.0
```

Raise `version` in `package.json`/`kon.json` for every release, and raise `sdk`
only when the kon starts using something a previous core does not offer.
