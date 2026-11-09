# kitsuden-kon-__KON_SLUG__

Kons for [Kitsuden](https://github.com/Kitsuden/kitsuden), started with
`kitsuden make kon __KON_SLUG__ --standalone`. Same layout as the official
[kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons) repository, so anything that works there
works here.

## Set up

A kon runs inside a Kitsuden API and shares its copy of `@kitsuden/shared`, `@kitsuden/engine`,
hono, drizzle-orm and zod. This repository does not install its own: it links a Kitsuden checkout
that already ran `pnpm install`.

```bash
KITSUDEN_DIR=../kitsuden pnpm link-core   # once: creates ./.kitsuden → that checkout
pnpm install
pnpm test                                 # every kon's tests, on PGlite
pnpm typecheck
```

## Add another kon

```bash
kitsuden make kon <name>                  # from anywhere inside this repository
```

## After adding or renaming files

```bash
pnpm kon:sync          # package.json `files` and kon.json `version`, from the folder
```

Version, tables and mount path live in each kon's `kon.json`; its `index.ts` reads them from there.
Bump the version in the kon's `package.json` and run `pnpm kon:sync`.

## Install a kon in a Kitsuden project

```bash
kitsuden kon add __KON_SLUG__ --from ../kitsuden-kon-__KON_SLUG__              # from this folder
kitsuden kon add __KON_SLUG__ --from https://github.com/<you>/kitsuden-kon-__KON_SLUG__.git --ref v0.1.0
```

Writing kons: Kitsuden's `docs/kons/README.md` (operations, policies, row security, testing).
