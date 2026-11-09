# @kitsuden/cli

Command-line tools for [Kitsuden](https://github.com/Kitsuden/kitsuden).

This README documents the commands that are tested (`packages/cli/tests`):

- `kitsuden new` creates a **frontend website** that reads from a Kitsuden API.
- `kitsuden make` generates code **inside the Kitsuden monorepo**: a kon, a policy, a request, a job or a test.

`kitsuden --help` also lists other commands (`init`, `dev`, `deploy` (Railway only), `migrate`, `gen types` and more). They are experimental, they are not covered by these tests, and this README does not document them.

## Requirements

- Node.js 22.12 or newer and pnpm 9 or newer.
- For `kitsuden make`: a clone of the Kitsuden repository with its dependencies installed (`pnpm install`).

From the Kitsuden repository, build the CLI and run it with Node:

```bash
pnpm --filter @kitsuden/cli build
pnpm kitsuden --help     # same as: node packages/cli/dist/index.js --help
```

The package is not on npm yet. The examples below call it `kitsuden`.

## `kitsuden new <name>`

Creates a website from the neutral starter (`packages/starters/kitsuden-starter-basic`). The starter is an Astro 7 server-rendered site that shows page-builder pages, the blog and the media library. Inti visual editing is optional. The starter's own README is copied into the project and explains all of this.

```bash
kitsuden new my-site --api-url http://localhost:3000
```

The command:

1. copies the starter into `./my-site`, leaving out `node_modules`, `dist`, `.astro`, `.env` and other local state;
2. renames the package to `my-site` and removes the monorepo's `repository`, `author` and `license` fields;
3. writes `.env` from `.env.example`, setting `KITSUDEN_API_URL`, `SITE_URL` and `SITE_NAME` (`KITSUDEN_SITE_KEY` stays commented out because it is a secret: add it by hand);
4. runs `pnpm install` if you passed `--install` or `--quickstart`;
5. prints the next steps.

Example output:

```
✔ Created …\my-site
  starter: …\packages\starters\kitsuden-starter-basic (monorepo)
  .env: KITSUDEN_API_URL=http://localhost:3000 SITE_URL=http://localhost:4321

Next steps

  cd my-site
  pnpm install
  pnpm dev            # http://localhost:4321 (needs the API running)
  pnpm build          # production build; it does not call the API
  pnpm start          # serve dist/ (reads KITSUDEN_API_URL at start)
```

| Option               | Effect                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `--api-url <url>`    | `KITSUDEN_API_URL` in `.env`: where the site's server reaches the API. Default `http://localhost:3000`.  |
| `--site-url <url>`   | `SITE_URL`: the public origin, used for canonical URLs and the sitemap. Default `http://localhost:4321`. |
| `--site-name <name>` | `SITE_NAME`. Default: the project name.                                                                  |
| `--install`          | Run `pnpm install` in the new project.                                                                   |
| `--quickstart`       | Ask no questions, use the defaults and run `pnpm install`.                                               |
| `-y`, `--yes`        | Ask no questions and use the options or the defaults.                                                    |
| `--from <dir>`       | Copy this starter folder instead of the default one.                                                     |
| `--api`              | Print how to get a Kitsuden API running. Works with or without a name.                                   |

In a terminal, `new` asks for the API URL unless you passed `--api-url`, `--yes` or `--quickstart`. Without a terminal (CI, pipes) it never asks a question. It refuses to write into a folder that already has files in it.

The command looks for the starter in this order: the `--from` folder, then the copy inside the CLI package (`templates/starter-basic`, which `prepack` adds when the package is packed), then the monorepo's `packages/starters/kitsuden-starter-basic`.

### The API is not created

`kitsuden new` creates only the website. There are no published Kitsuden API images yet, so the CLI does not generate a `docker-compose.yml` for the API. Such a file would point to images that do not exist. Install the API from the Kitsuden repository by following `docs/install/`:

- `server.md`: Docker (recommended).
- `local.md`: local development with Bun, Postgres and Valkey.
- `first-run.md`: migrations and the first admin.

`kitsuden new --api` prints the same pointers.

## `kitsuden kon add|remove|list`

Kons are not part of the Kitsuden core: they are installed from
[kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons) (or any
repository with `kons/<kon-id>/kon.json`).

```bash
kitsuden kon add blog                         # from ../kitsuden-kons, else the official repo
kitsuden kon add shop --from https://github.com/acme/kons.git --ref v1.2.0
kitsuden kon add blog --link                  # use it in place (kon development)
kitsuden kon list [--available] [--json]
kitsuden kon remove blog                      # tables and data stay
```

`add` checks the kon's `sdk` against this Kitsuden (`GET /api/version` of
`--api-url`, or the core's code), installs its kon dependencies, copies it to
`packages/kons/<kon-id>/`, declares it in `kitsuden.kons.json`, runs
`pnpm install` and `apps/api/scripts/migrate.ts --kon <kon-id>`. It refuses to
overwrite a copy with local changes unless `--force`. Details:
[docs/kons/installing.md](../../docs/kons/installing.md).

## `kitsuden make <kind> <name>`

Run it inside the Kitsuden monorepo. It finds the repository root from the current folder. You can also give the root with `--root <dir>`.

### `make kon <name>`

The one command to start a kon. It works in three places:

```bash
kitsuden make kon recipes                  # in a Kitsuden project → packages/kons/kon-recipes/
kitsuden make kon recipes                  # in a kons repository  → kons/kon-recipes/
kitsuden make kon recipes --standalone     # anywhere: a new kons repository ./kitsuden-kon-recipes/
```

What it writes in the kon folder:

```
kon.json                     the one place for id, version, tables, mount path, maturity, category
package.json                 files[], typecheck script
tsconfig.json
index.ts                     defineKonSdk(...), reading version and tables from kon.json
recipes.schema.ts            Drizzle table (types only)
recipes.policy.ts            deny-by-default policy; actAsUser: actsAsUserIn("recipes")
recipes.routes.ts            CRUD as SDK operations: REST + OpenAPI 3.1 + MCP tools
migrations/0000_initial.sql  the table, and its row security in two lines (kitsuden_rls_team, kitsuden_rls_public_read)
README.md
```

plus `tests/unit/kon-recipes.test.ts`: the real routes on PGlite, as a non-superuser role, behind
the host's per-request row security, so the policy and the database rules run from the first test.

The generated kon is a list of items, each with a title, a body and a status (`draft` or
`published`). Anyone can read published items. Only the kon's team (admin, editor, or an agent
with the kon's scope) sees drafts and writes. The tables are created by the migration, never at
runtime.

Options: `--icon <Name>` takes a lucide icon that must be in the admin's icon map (default
`Package`). `--title <text>` and `--description <text>` set the kon's name and description.
`--standalone [dir]` picks the new repository's folder. `--force` overwrites the generated files
of an existing kon. The command refuses names that are not lowercase-and-dashes, kons that already
exist, mount paths or table names that another kon uses, and icons that the admin cannot show.

The command prints the next steps for where it ran (in a project: `pnpm install`, the test,
`pnpm db:migrate`; in a kons repository: `pnpm link-core`, `pnpm install`, the test,
`pnpm kon:sync` after adding files).

### `make policy <Name> --kon <kon>`

This and the other generators below (`make model`, `make request`, `make job`, `make test`) work in a Kitsuden project and in a kons repository alike (there, `--kon` is required, since a kons repository has no app). In a kons repository they also run `kon:sync`, so a new file is added to the kon's `files[]`.

```bash
kitsuden make policy Draft --kon recipes
```

Policies live in the kon that owns the resource. The command adds `definePolicy("recipes-draft", …)` inside `registerRecipesPolicy()` in `recipes.policy.ts`. If the kon has no policy file yet, it creates `<kon>.policy.ts` with a `register<Kon>Policy()` function and tells you how to import it from the routes and how to add it to `files[]`. Without `--kon` the command stops with an error, because the API has no policies folder that anything loads.

### `make request`, `make job`, `make test`

| Command                              | Writes                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `make request CreatePost --kon blog` | `packages/kons/kon-blog/create-post.request.ts` (zod schema and `validateRequest` middleware) |
| `make job SendEmail --kon blog`      | `packages/kons/kon-blog/send-email.job.ts`                                                    |
| `make test search --kon blog`        | `tests/unit/kon-blog-search.test.ts` (vitest)                                                 |
| `make request CreatePost`            | `apps/api/src/requests/create-post.request.ts`                                                |
| `make job SendEmail`                 | `apps/api/src/jobs/send-email.job.ts`                                                         |
| `make test payment`                  | `apps/api/src/tests-unit/payment.test.ts` (bun:test)                                          |

These files are not imported by anything until you import them. When `index.ts` imports a new kon file, add that file to the kon's `files[]`.

## Tests

```bash
pnpm --filter @kitsuden/cli build
pnpm --filter @kitsuden/cli test
```

- `tests/new.test.mjs` runs `kitsuden new` in a temporary folder with an API URL where nothing listens. It checks what was copied, the package name and `.env`. Then it runs `pnpm install` and `pnpm build` on the new project, so it needs network access. Set `KITSUDEN_CLI_SKIP_INSTALL=1` to skip that last step.
- `tests/kon.test.mjs` runs `kon add|list|remove` with the built CLI on a fake project and a fake kons repository in a temporary folder: copy without `node_modules`, kon dependencies (manifest and peers), the migration runner called with `--kon <id>`, SDK refusal, local-change protection, `--link`, `--enable`, and `remove` refusing a kon another one depends on.
- `tests/make-kon.test.mjs` copies the parts of the monorepo that the kon guards read into a temporary folder and links the existing `node_modules`. It then runs `make kon` and `make policy` there. It also runs the repository's kon guards (`kon-manifest`, `kon-loadable`, `kon-tables`, `kons-do-not-create-tables`, `kon-icons`, `full-published-package`, `kon-typecheck-coverage`, `kon-registry-full`), the generated route test and `tsc --noEmit` on the new kon. The real repository is not modified.

## License

MIT
