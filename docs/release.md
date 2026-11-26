# Releasing Kitsuden

How a version goes to npm and to ghcr.io from a workstation. The same can run in CI
(`.github/workflows/publish.yml` and `docker-publish.yml`, on a `v*` tag); this page
is the manual path, written for Windows CMD with npm's security-key 2FA.

## What is published

| npm package            | What it is                                          | Depends on (ours)                |
| ---------------------- | --------------------------------------------------- | -------------------------------- |
| `@kitsuden/shared`     | types and Zod schemas shared by the API and clients | none                             |
| `@kitsuden/codegen`    | frontend code generation for collections            | none                             |
| `@kitsuden/sdk`        | the typed client (zero runtime dependencies)        | none                             |
| `@kitsuden/cli`        | the `kitsuden` command                              | `@kitsuden/codegen`              |
| `@kitsuden/mcp-server` | the MCP server for agents (runs on Bun)             | none                             |
| `create-kitsuden`      | `npm create kitsuden`                               | none                             |
| `kitsuden`             | the SDK and the `kitsuden` command in one install   | `@kitsuden/sdk`, `@kitsuden/cli` |

Publish them in that order: each one after the ones it depends on.

Images: `ghcr.io/kitsuden/kitsuden/api` and `ghcr.io/kitsuden/kitsuden/admin`
(`docker/Dockerfile.prod`, targets `api` and `admin`). `create-kitsuden` scaffolds a
compose file that pulls both at the tag of its own version, so the images of a
version must be pushed **before** its `create-kitsuden` is announced.

Not published: `@kitsuden/api`, `@kitsuden/admin`, `@kitsuden/engine`, the core kons
(`packages/core/*`, which import the API's internals), `@kitsuden/testing`,
`@kitsuden/sdk-react` and `@kitsuden/vector-search`.

## 1. Pack and check (anyone)

```bash
node scripts/release/pack.mjs      # tests, prepack (delete dist/, build), pnpm pack, inspect
node scripts/release/smoke.mjs     # install the tarballs into an empty project and use them
```

`pack.mjs` writes `release/<name>-<version>.tgz` and `release/manifest.json`
(order, dist-tag, sha512). It stops on a tarball with a test file, a `.env`, a key,
a token, a connection URL with a password, a path of this machine, a `workspace:`
range, or a `main`/`exports` pointing at TypeScript sources.

Why `pnpm pack` and then `npm publish <tarball>`: `pnpm pack` rewrites the
`workspace:` ranges to real versions (`npm pack` would leave them, and the package
would not install), and `npm publish` of a tarball does the security-key 2FA in the
browser. The file published is the file that was checked.

## 2. Publish to npm (the owner, CMD)

Logged in as a member of the `kitsuden` npm org (`npm whoami`). From the repository
root, one command per package, in this order. Each one opens the browser for the
security key:

```bat
npm publish release\kitsuden-shared-0.9.0-beta.tgz --tag beta --access public
npm publish release\kitsuden-codegen-0.9.0-beta.tgz --tag beta --access public
npm publish release\kitsuden-sdk-0.9.0-beta.tgz --tag beta --access public
npm publish release\kitsuden-cli-0.9.0-beta.tgz --tag beta --access public
npm publish release\kitsuden-mcp-server-0.9.0-beta.tgz --tag beta --access public
npm publish release\create-kitsuden-0.9.0-beta.tgz --tag beta --access public
npm publish release\kitsuden-0.9.0-beta.tgz --tag beta --access public
```

A prerelease (`x.y.z-beta`) always goes with `--tag beta`: without it npm 10 makes it
`latest` (npm 11 refuses to publish it).

## 3. Images (the owner)

Build one at a time, and look at the free space first: the builds run in the same
Docker Desktop as anything else on the machine.

```bat
docker build -f docker/Dockerfile.prod --target api -t ghcr.io/kitsuden/kitsuden/api:0.9.0-beta .
docker build -f docker/Dockerfile.prod --target admin -t ghcr.io/kitsuden/kitsuden/admin:0.9.0-beta .
```

Push with a GitHub personal access token (classic) with `write:packages`, from an
account that can write to the `Kitsuden` organization's packages:

```bat
docker login ghcr.io -u <github-user>
docker push ghcr.io/kitsuden/kitsuden/api:0.9.0-beta
docker push ghcr.io/kitsuden/kitsuden/admin:0.9.0-beta
```

`docker login` asks for the password: paste the token there, never on the command line.

`:latest` only for a stable version. It is made in the registry, from the tag just
pushed, without retagging anything locally (a local `:latest` may be what a running
deployment on the same machine uses):

```bat
docker buildx imagetools create -t ghcr.io/kitsuden/kitsuden/api:latest ghcr.io/kitsuden/kitsuden/api:0.9.0
docker buildx imagetools create -t ghcr.io/kitsuden/kitsuden/admin:latest ghcr.io/kitsuden/kitsuden/admin:0.9.0
```

A new ghcr.io package starts **private**. In GitHub: Kitsuden organization →
Packages → `kitsuden/api` → Package settings → Change visibility → Public; the
same for `kitsuden/admin`. Link each one to the `Kitsuden/kitsuden` repository there
too. Without that, `npm create kitsuden` makes a project whose `docker compose up`
cannot pull.

## 4. Git tag and GitHub release

On the merged commit of `main` that was packed:

```bat
git tag -a v0.9.0-beta -m "Kitsuden 0.9.0-beta"
git push origin v0.9.0-beta
gh release create v0.9.0-beta --prerelease --title "Kitsuden 0.9.0-beta" --generate-notes
```

Pushing a `v*` tag also starts `publish.yml` and `docker-publish.yml`. After a manual
publish they would fail on "version already published": cancel those runs, or let
CI publish instead of steps 2 and 3 (it needs the `NPM_TOKEN` secret and the
`release` environment).

## 5. Check

A new package can answer `0.0.0-stage` or 404 for a few minutes after the first
publish. Then:

```bat
npm view @kitsuden/shared dist-tags
npm view @kitsuden/codegen dist-tags
npm view @kitsuden/sdk dist-tags
npm view @kitsuden/cli dist-tags
npm view @kitsuden/mcp-server dist-tags
npm view create-kitsuden dist-tags
npm view kitsuden dist-tags
```

Each must show `beta: '0.9.0-beta'`. The registry also points `latest` at the first
version published; if a package shows no `latest`, add it:
`npm dist-tag add <name>@0.9.0-beta latest`.

```bat
npm view @kitsuden/sdk@0.9.0-beta dist.integrity
```

must match the `integrity` of that package in `release\manifest.json`. Then, in an
empty folder:

```bat
npx @kitsuden/cli@beta --version
npx kitsuden@beta --help
npm create kitsuden@beta demo -- --yes
cd demo && docker compose pull
```

`docker compose pull` must download `api` and `admin` at `0.9.0-beta` without
logging in: that is the proof the images are public.

Team access to the `kitsuden` npm org (who else can publish) is set on
npmjs.com → the org → Teams; `npm access` from the command line needs an OTP, which
a security key does not give.
