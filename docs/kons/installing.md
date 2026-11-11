# Installing kons

Kitsuden ships **without kons**: the core (API, agents, MCP, datasets, media,
page builder, admin panel) is complete on its own. Kons are installed from the
official [kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons) repository, or from any
repository or folder with the same layout (`kons/<kon-id>/` with a `kon.json`) — yours included
(`kitsuden make kon <name> --standalone` starts one). What is core and what is a kon, and why:
[core-and-kons.md](core-and-kons.md).

## The usual way

The CLI is not on npm yet, so it runs from your clone of Kitsuden. Build it once, then call
it as `pnpm kitsuden` from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @kitsuden/cli build     # once, and again after updating the code
pnpm kitsuden kon add blog
```

That is the whole procedure: it finds the kon in the official repository (a `../kitsuden-kons`
checkout if you have one, else fetched from GitHub, which asks for a yes: see
[Git sources are unsigned](#git-sources-are-unsigned)), copies it into `packages/kons/`,
installs it, runs its migrations and declares it. Restart the API (or switch the kon on in the
panel). The rest of the commands:

```bash
pnpm kitsuden kon list --available      # what the source offers, with maturity
pnpm kitsuden kon add wiki comments --enable --trust-source
pnpm kitsuden kon add shop --from ../my-kons          # a folder, or a git URL with --ref <tag>
pnpm kitsuden kon list                  # what is installed, and its state
pnpm kitsuden kon remove blog           # its tables and data stay
```

`pnpm kitsuden` is `node packages/cli/dist/index.js`; wherever these docs write `kitsuden`,
that is the command. Once `@kitsuden/cli` is published on npm, the same commands will also run
as `npx @kitsuden/cli …`; until then that name does not exist on npm, so do not run it.
Kitsuden's API runs on Bun: install Bun (https://bun.sh) before starting the API.

**When you need more than that.** For signed, versioned installs with a permission prompt and a
lockfile (`kitsuden kon add blog@^2`, for teams that pin what runs in production), use the
registry: [registry.md](registry.md). It is optional; source installs are the default and this
page is about them.

`kitsuden kon add <name>…`:

1. finds the kon in the **source**: `--from <path|git-url>` (`--ref <tag|commit>`
   for git), else `KITSUDEN_KONS_SOURCE`, else a `../kitsuden-kons` checkout next
   to the project, else the official repository (fetched into
   `.kitsuden/kons-cache/`);
2. with a **git source**, stops for a yes: see [Git sources are unsigned](#git-sources-are-unsigned);
3. checks its **SDK version**: the `sdk` of its `kon.json` against this
   Kitsuden's (`GET /api/version` → `sdk.kons` of a running API given with
   `--api-url`/`KITSUDEN_API_URL`, or the core's code). A kon written for a
   newer SDK is refused and nothing is touched;
4. adds the kons it depends on (`dependencies.kons` in `kon.json`, and
   `@kitsuden/kon-*` peers). A malformed id, a folder whose manifest names another
   kon, a lifecycle script (`postinstall`, `prepare`…) or a symbolic link stops the
   install, and nothing is touched;
5. **copies** it to `packages/kons/<kon-id>/` (without `node_modules`/`dist`) and
   records a hash of the copy;
6. declares it in **`kitsuden.kons.json`** at the project root;
7. runs `pnpm install --ignore-scripts` and the normal migration runner with
   `--kon <kon-id>` (`apps/api/scripts/migrate.ts`, the same one the container
   runs at startup).

Then restart the API. A kon that is not on by default is switched on in the
admin panel (**Kons**), or installed with `--enable` (the seed used the first
time the database hears of it; after that, the panel decides).

Options: `--link` (use the kon where it is, for kon development, see below),
`--force` (overwrite a copy with local changes), `--trust-source`, `--latest`,
`--no-install`, `--no-migrate`, `--root <dir>`.

### Git sources are unsigned

Installing from git, the official repository included, runs code that nothing
verifies: the migrations run with the DDL role and the API loads the kon in its
own process. A signed [registry](registry.md) is what checks a publisher. So:

- `kon add` shows the source and the exact commit and asks for a yes. Without a
  terminal, it needs `--trust-source`; otherwise nothing is installed (exit 3).
  `--yes` does not count here.
- The commit is recorded in `kitsuden.kons.json` (`commit`), and a later `kon add` of
  the same kons stays on it, so a new push reaches you only when you ask:
  `--latest`, or `--ref <tag|commit>`.
- `pnpm install` runs with `--ignore-scripts`, and a kon that declares lifecycle
  scripts is refused.

A local folder (`--from ../kitsuden-kons`) needs no confirmation: it is code you
already have.

`kitsuden kon remove <name>` refuses if another installed kon depends on it,
or if the copy has local changes (unless `--force`; `--keep-files` keeps the
folder). It **never drops tables**: the kon's data stays in the database. If the
kon is still active in the panel, the API logs it as "active but not installed"
and does not mount it.

## What the API reads

The API mounts what is **installed and active**:

- **installed** — `apps/api/src/lib/installed-kons.ts`: the core modules of
  `packages/core/*`, plus what `kitsuden.kons.json` declares, plus
  `KITSUDEN_KONS` in the environment. Nothing else: a folder in `packages/kons/`
  that is not declared is not loaded, and the loader no longer scans
  `node_modules`.
- **active** — the `modules` table, i.e. the admin panel.

A declared kon is looked for, in this order, at its `path` (absolute or
relative to the project root), at `packages/kons/<kon-id>/`, and in
`node_modules` (`@kitsuden/<kon-id>`, `<kon-id>`, or its `package`).

`KITSUDEN_KONS` is a comma-separated list; each item is an id, or an id with
its location:

```bash
KITSUDEN_KONS="blog,wiki=../kitsuden-kons/kons/kon-wiki,shop=@acme/kon-shop"
```

Before importing a kon, the loader compares its `sdk` with the core's. One that
needs a newer SDK is **not mounted** and the reason is logged
(`❌ kon-x → NOT mounted: kon-x needs kon SDK v2 and this Kitsuden provides v1 …`).

An installed kon that is switched on from the panel starts answering **without
a restart**: at startup the loader reserves the mount path of every installed,
inactive kon (the `mount.path` of its `kon.json`, or the `mountPath` read from
its code when the manifest does not declare it).

## Docker

The API image installs the kons listed in the `KITSUDEN_KONS` **build
argument**, copied from the additional build context `kons` (a checkout of
kitsuden-kons). With neither, the image is the core only.

The short way, in your checkout:

```bash
kitsuden kon add blog comments wiki --no-migrate --docker
docker compose -f docker-compose.yml -f docker-compose.kons.yml build kitsuden_api
```

`--docker` writes `docker-compose.kons.yml` from `kitsuden.kons.json`, and from then on every
`kon add` and `kon remove` rewrites it, so the image and your checkout never list different kons.
It needs the kons to come from one local folder (the build context); with a git source it tells you
and leaves the file alone. `--no-migrate` is for Docker-only setups, which have no
`apps/api/.env`: the container runs the migrations when it starts.

Why the checkout step: the image builds with `pnpm install --frozen-lockfile`, and the
`pnpm-lock.yaml` of a fresh clone has no kons in it. Adding them updates the lockfile; keep it in
your deployment, or the build stops with `ERR_PNPM_OUTDATED_LOCKFILE`.

What `--docker` writes (you can also write it by hand):

```yaml
# docker-compose.kons.yml (your overlay)
services:
  kitsuden_api:
    build:
      additional_contexts:
        kons: ../kitsuden-kons
      args:
        KITSUDEN_KONS: "blog,comments,wiki"
```

```bash
docker compose -f docker-compose.yml -f docker-compose.kons.yml build kitsuden_api
```

or, without compose:

```bash
docker build -f docker/Dockerfile.prod --target api \
  --build-context kons=../kitsuden-kons \
  --build-arg KITSUDEN_KONS="blog,comments,wiki" -t my/api .
```

`docker/install-kons.mjs` copies each kon into the image, refuses to build if a
listed kon depends on one that is not listed, and writes the image's
`kitsuden.kons.json`. The copies in your working tree (`packages/kons/kon-*`)
are excluded from the build context: the image contains what you declared, not
what happens to be in your folder. Migrations of the installed and active kons
run when the container starts, as for the core.

## Developing a kon inside a project

```bash
kitsuden kon add blog --from ../kitsuden-kons --link
```

`--link` declares the kon's own folder (`"path"` in `kitsuden.kons.json`) instead
of copying it, so your edits are live after an API restart. The kon's imports
then resolve from **its** folder, so that checkout of kitsuden-kons must be
linked to this same Kitsuden (`KITSUDEN_DIR=<this project> node
scripts/link-core.mjs` in kitsuden-kons): otherwise the kon would load a
second copy of `@kitsuden/engine`, `hono` or `drizzle-orm`. With a copy
(the default) this cannot happen.

The copies in `packages/kons/` are git-ignored in the Kitsuden repository. Do
not edit them: change the kon in its repository and run `kitsuden kon add`
again (it refuses to overwrite local changes unless `--force`).

## Tests in a project without kons

The core's test suites run with no kon installed. Tests that use a kon as their
example (`kon-blog` for human approval, `kon-games` for the Inti contract…) are
skipped when that kon is not installed (vitest prints which ones and why). The
kons' own tests live in kitsuden-kons.
