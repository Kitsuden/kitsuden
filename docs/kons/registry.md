# The kon registry: signed, versioned kons

Kons can be installed from a **source folder** (`kitsuden kon add blog --from
../kitsuden-kons`, see [installing.md](installing.md)) or from a **registry**:
a signed index of immutable, versioned packages that anyone can host and
anyone can publish to with their own key. This page is for both sides:
[users](#installing-from-a-registry) and [publishers](#publishing). No public
registry is running yet: the examples use made-up URLs, and today you either
host one yourself or install from a source folder.

```bash
kitsuden kon search comments
kitsuden kon info character-builder
kitsuden kon add character-builder@^1.1 comments     # shows the permissions, asks
kitsuden kon outdated
kitsuden kon update                                   # within the ranges you asked for
kitsuden kon verify                                   # installed copies vs the lockfile
kitsuden kon sync                                     # install exactly what the lockfile pins
```

## Contents

- [How trust works](#how-trust-works)
- [Installing from a registry](#installing-from-a-registry)
- [The permission prompt](#the-permission-prompt)
- [The lockfile](#the-lockfile)
- [Publishing](#publishing)
- [Yanking, advisories and revocation](#yanking-advisories-and-revocation)
- [The manifest (kon.json, spec 1)](#the-manifest-konjson-spec-1)
- [The package format](#the-package-format)
- [The index format](#the-index-format)
- [Hosting a registry](#hosting-a-registry)
- [Security model and limits](#security-model-and-limits)
- [Why minisign and not Sigstore](#why-minisign-and-not-sigstore)
- [Command reference](#command-reference)

## How trust works

There are two kinds of keys, both Ed25519 in the
[minisign](https://jedisct1.github.io/minisign/) format:

- the **registry key** signs the index. You configure its public key in your
  project; it is the only thing you have to trust up front;
- a **publisher key** signs each package. The signed index lists which
  publisher keys may publish each kon (`owners`).

A package is installed only if **all** of this holds:

1. the index signature verifies with the registry key you configured, and its
   `serial` is not older than one you already saw (no rollback), and it has
   not expired (if it sets `expires`);
2. the package's size and SHA-256 equal what the signed index says;
3. the package's own signature verifies with a publisher key that the signed
   index lists as an owner of that kon and has not revoked;
4. the signature's _trusted comment_ (which is signed too) names the same kon
   id, version, SHA-256 and content hash, so a valid signature cannot be moved
   onto another package;
5. the tarball parses under the [safe extraction rules](#the-package-format);
6. the `kon.json` inside the package is valid and equal to the manifest the
   index announced;
7. the version is not yanked (for a new install) and not revoked by an
   advisory (ever).

Someone who controls only the static host (GitHub Pages, a bucket) cannot ship
code: they would need the registry key to change the index or a publisher key
to sign a package. Verification needs no network beyond fetching the files:
it works offline from a local folder, and `kon verify --file` checks a single
package with nothing but the publisher's public key.

## Installing from a registry

Configure the registry once, in `kitsuden.registries.json` at the project root
(commit it):

```json
{
  "default": "official",
  "registries": {
    "official": {
      "url": "https://kons.example.org/index.json",
      "key": "RWQ…the registry public key, base64 line of its .pub file…"
    },
    "acme": {
      "url": "../acme-registry",
      "key": "./keys/acme-registry.pub",
      "trustedPublishers": ["A4B7A487EBEE18B8"]
    }
  }
}
```

- `url`: an `https://` URL, a `file://` URL, or a folder (relative to the
  project). Plain `http://` is refused except for `localhost`.
- `key`: the registry public key, inline or as a path to the `.pub` file.
- `trustedPublishers` (optional): accept packages from these publisher key ids
  only, whatever the index says.

`--registry <name|path|url>` and `--registry-key <key>` (or
`KITSUDEN_KON_REGISTRY`, `KITSUDEN_KON_REGISTRY_KEY`) override it for one
command.

`kitsuden kon add` installs from the registry when a registry is configured
(or `--registry` is given, or you ask for a version: `blog@^2`) and you did not
pass `--from` or `--link`. `--from` keeps working exactly as before for source
installs.

```bash
kitsuden kon add blog                 # the highest version that fits
kitsuden kon add blog@^2.1 wiki@~1.4  # ranges: ^ ~ >= < x || and hyphen ranges
kitsuden kon add blog --dry-run       # resolve, verify, show permissions; install nothing
```

What `add` does, in order: load and verify the index; resolve versions
(semver, kon-to-kon dependency ranges, the core range `kitsuden`, the kon SDK);
download, verify and extract every package into a staging folder; validate the
manifests; show the [permission prompt](#the-permission-prompt); then, and
only then, copy into `packages/kons/<id>/`, declare in `kitsuden.kons.json`
(`"source": "registry:<name>"`), write `kitsuden.kons.lock`, run `pnpm install`
and the **normal migration runner** (`apps/api/scripts/migrate.ts --kon <id>`).
A failure before the prompt leaves the project untouched.

Registry kons are ordinary installed copies: the API loads them like any other
kon, `kon list` shows them, `kon remove` removes them (and their lockfile
entry). Their migrations go through the same runner, the same checksums table
and, at runtime, the same limited DDL role (`DATABASE_DDL_URL`,
[sandbox.md](../agents/sandbox.md)) as every other kon: the registry adds no
new way to run SQL.

**Resolution rules.** Each kon gets the highest version that satisfies every
range that applies to it (yours and those of the kons that depend on it), is
not yanked, is not revoked, declares a `kitsuden` range this core satisfies
(the core's pre-release tag is ignored: `0.9.0-beta` satisfies `>=0.9.0`) and
an `sdk` it provides. A version the lockfile pins is kept while it fits;
`update` lifts the pin. Core kons (`kon-media`, `kon-datasets`,
`kon-blocks`) and kons installed from a source folder satisfy dependencies
without coming from the registry, if their version fits. A conflict is
reported with who asked for what.

## The permission prompt

Before installing, `add` and `update` print what every kon in the plan
**declares**: license, author, repository, scopes, outbound hosts, sensitive
operations, tables and migrations, with `+` marking what is new compared with
the installed version (the idea of the capability diff of
[code promotion](../agents/promotion.md#declared-capabilities)).

| Situation                                                                                                                       | What it takes                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A new kon (or a new dependency)                                                                                                 | Answer `y`, or `--yes`                                               |
| An update that does not widen anything                                                                                          | Answer `y`, or `--yes`                                               |
| An update that **widens** scopes, removes a `!deny`, adds an outbound host or a sensitive operation, or changes the signing key | Answer `y`, or **`--yes --accept-wider`** (`--yes` alone is refused) |
| No terminal and none of the flags                                                                                               | Nothing is installed; exit code 3                                    |

Wildcards count, as in promotion: `datasets:*:read` covers
`datasets:clients:read`, and `*.example.com` covers `api.example.com`.

**What the declaration is, and is not.** A kon runs inside the API process
with the API's privileges; Kitsuden does not sandbox kon code. The permissions
block is what the publisher **declares** and you **consent to**; it is signed,
so it cannot change without a new version and a new prompt, and a widening is
always visible. It is not a runtime boundary: review the code of a kon you do
not trust (the package is in `.kitsuden/kons-cache/registry/`, and installed in
`packages/kons/<id>/`).

## The lockfile

`kitsuden.kons.lock` (commit it) pins, for each registry kon: exact version,
registry, tarball URL, SHA-256 of the package, content hash of its files,
signing key id and public key, license, dependencies, the range you asked for,
and the full normalized manifest (the baseline of the next permission diff).
It also records the highest index `serial` seen per registry.

- `kon sync` installs exactly what the lockfile says, verifying every package
  again; it refuses a package whose bytes differ from the lockfile, a revoked
  version, or a changed signing key (unless `--yes --accept-wider`). A yanked
  version the lockfile pins is still installed, with a warning (Cargo's rule).
- `kon verify` checks, offline, that each installed copy still hashes to the
  signed content and that the cached package still verifies with the recorded
  publisher key; if the registry is reachable it also reports revocations
  since install. It exits 1 on any problem.
- A published version is immutable: if the registry ever serves different
  bytes for a locked version, every command refuses it.

## Publishing

You need a **publisher key** (and, if you also run the registry, a registry
key; it can be the same key for a one-person registry):

```bash
KITSUDEN_SIGNING_PASSPHRASE='…' kitsuden kon keygen --out ~/.kitsuden/keys/acme
# → acme.pub (share it), acme.key (secret, encrypted with the passphrase)
```

`keygen` refuses to write inside a git repository (`--force` overrides). Keep
the `.key` file out of every repository and CI log; set
`KITSUDEN_SIGNING_PASSPHRASE` when using an encrypted key.

Prepare the kon's `kon.json` ([spec 1](#the-manifest-konjson-spec-1)), then:

```bash
kitsuden kon publish ./kons/kon-acme \
  --registry ../acme-registry \
  --key ~/.kitsuden/keys/acme.key \
  --index-key ~/.kitsuden/keys/acme-registry.key     # omit if the same key
kitsuden kon publish ./kons/kon-acme --registry ../acme-registry --key … --dry-run
```

`publish` validates the manifest, refuses lifecycle scripts, symlinks and
secret-looking files (`.env`, private keys, `.npmrc`), packs a deterministic
tarball, signs it, verifies the current index signature with the registry key
(it never re-signs an index someone else changed), adds the version and
re-signs the index with `serial + 1`. It writes to a **local folder only**;
uploading that folder is a separate step ([hosting](#hosting-a-registry)).

- Versions are immutable: the same `id@version` cannot be published twice.
- The first key to publish a kon owns it. Another key is refused unless the
  registry key holder adds it with `--add-owner`.
- A dependency that is not in the registry yet is a warning.
- Pre-releases (`1.0.0-beta.1`) are published but only picked by a range that
  names a pre-release (`^1.0.0-beta.0`).

**Third parties.** Today a registry is written by whoever holds its registry
key, so a third party either runs its own registry (users add it to
`kitsuden.registries.json`, optionally with `trustedPublishers`) or has the
operator of a shared registry run `publish` for them. Importing a package that
was signed elsewhere into a shared registry (a pull-request flow where the
publisher signs and the operator only re-signs the index) is **not implemented
yet**. Either way the client never trusts a publisher key that the signed index
does not list.

## Yanking, advisories and revocation

All of these need the registry key and re-sign the index:

```bash
kitsuden kon yank kon-acme@1.2.0 --registry ../acme-registry --index-key reg.key --reason "breaks migrations"
kitsuden kon yank kon-acme@1.2.0 --registry … --index-key … --undo
kitsuden kon yank kon-acme@1.2.0 --registry … --index-key … \
  --advisory "token leak in logs" --severity high                  # advisory + yank
kitsuden kon yank kon-acme@1.2.0 --registry … --index-key … \
  --revoke --advisory "malicious build" --severity critical --range "<=1.2.0"
kitsuden kon yank x --registry … --index-key … --revoke-key A4B7A487EBEE18B8
```

|                                       | New installs                       | Lockfile pins it (`sync`) | `verify` / `outdated` |
| ------------------------------------- | ---------------------------------- | ------------------------- | --------------------- |
| **yanked**                            | refused                            | installed, with a warning | warning               |
| **advisory** (not revoking)           | allowed, with a warning            | allowed, with a warning   | listed                |
| **revoked** (advisory with `revoked`) | refused                            | refused                   | error                 |
| **revoked publisher key**             | every package it signed is refused | refused                   | error                 |

## The manifest (kon.json, spec 1)

A published kon is described by the `kon.json` every kon already has. Spec 1
fixes what a published kon must carry; every other field (`admin`, `mount`,
`tier`, `maturity`…) is kept as is. The schema is
`packages/schemas/kon-schema.json`.

```json
{
  "manifest": 1,
  "id": "kon-acme",
  "name": "Acme",
  "description": "What it does",
  "version": "1.2.0",
  "sdk": 1,
  "kitsuden": ">=0.9.0 <2",
  "license": "MIT",
  "author": { "name": "Acme Ltd", "email": "kons@acme.example" },
  "repository": {
    "type": "git",
    "url": "https://github.com/acme/kons.git",
    "directory": "kons/kon-acme"
  },
  "dependencies": { "kons": ["kon-formulas"], "versions": { "kon-formulas": "^1.0.0" } },
  "tables": ["acme_items"],
  "permissions": {
    "scopes": ["kon:acme:list", "kon:acme:delete"],
    "hosts": ["api.acme.example"],
    "sensitive": ["delete"]
  }
}
```

| Field                   | Rule                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`              | `1` (optional; a higher value is refused by this CLI)                                                                                                                                                                                                                                                                                         |
| `id`                    | `kon-<kebab-case>`                                                                                                                                                                                                                                                                                                                            |
| `version`               | semver; must equal `version` in `package.json`                                                                                                                                                                                                                                                                                                |
| `name`, `description`   | required                                                                                                                                                                                                                                                                                                                                      |
| `sdk`                   | integer ≥ 1, required to publish                                                                                                                                                                                                                                                                                                              |
| `kitsuden`              | semver range of the core; also read from `compatibility.kitsuden` or `package.json` `kitsuden.minVersion`; required to publish                                                                                                                                                                                                                |
| `license`               | SPDX expression (`MIT`, `MIT OR Apache-2.0`, `LicenseRef-Acme`), required to publish; an id outside the well-known list is a warning                                                                                                                                                                                                          |
| `author`                | string or `{name, email?, url?}`, required to publish                                                                                                                                                                                                                                                                                         |
| `repository`            | URL or `{type?, url, directory?}`; recommended                                                                                                                                                                                                                                                                                                |
| `dependencies.kons`     | **array** of kon ids: the API loader, `kon add --from` and the Docker installer read it as an array                                                                                                                                                                                                                                           |
| `dependencies.versions` | optional `{id: range}` for ids in `dependencies.kons`; a missing range means any version                                                                                                                                                                                                                                                      |
| `tables`                | table names (strings or `{name, …}` objects)                                                                                                                                                                                                                                                                                                  |
| `migrations`            | not written by hand: `publish` records the files of `migrations/*.sql`                                                                                                                                                                                                                                                                        |
| `permissions`           | **required to publish**: `scopes` (scopes the kon defines or uses, `kon:<short>:<operation>`, core scopes; `!scope` is a denial), `hosts` (outbound hosts, `*.domain` allowed, a bare `*` is not), `sensitive` (ids of its operations with `sensitive: true`; DELETE operations are sensitive by default). Empty lists are an explicit "none" |

Admin views of type `element` (Web Components that the panel loads at runtime)
keep their path rules: `src` relative, no `..`, no absolute path or URL, only
`.js/.mjs/.css/.map`. `package.json` must not have lifecycle scripts
(`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, …): pnpm runs a
workspace package's lifecycle scripts, so a kon with one is refused at publish
and again at install. The kon's third-party npm dependencies install under the
project's `onlyBuiltDependencies` allowlist like any other.

## The package format

`<id>-<version>.tgz`: a gzip'ed ustar archive with every file under
`package/`, built deterministically (entries sorted, mode 0644, uid/gid 0,
mtime 0, no directory entries, gzip mtime 0 and OS byte 255). The same folder
packs to the same bytes with the same zlib. What is packed is what a source
install copies (no `node_modules`, `dist`, `.git`, `coverage`, `.turbo`,
`*.tsbuildinfo`), so the installed copy's `hash` in `kitsuden.kons.json`
equals the package's `contentHash` (SHA-256 over path, NUL, bytes, NUL for the
sorted files).

The signature is `<tgz>.minisig` (minisign, algorithm `ED`: Ed25519 over
BLAKE2b-512 of the file), with the trusted comment
`kitsuden-kon id=… version=… sha256=… content=… timestamp=…`.

**Extraction rules** (the reader treats every archive as hostile):

- only regular files and directories: symlinks, hard links, devices, FIFOs and
  pax/GNU extension headers are refused;
- every path is `package/<relative>` with no empty, `.` or `..` segment, no
  backslash, colon, NUL or control character, no Windows reserved name (`CON`,
  `NUL`, `COM1`…), no segment ending in a dot or space; duplicates are refused
  case-insensitively, and a path whose parent is also a file is refused;
- header checksums are verified;
- limits: 20 MiB compressed, 64 MiB expanded (checked while inflating, so a
  gzip bomb stops early), 16 MiB per file, 10 000 files, 255-byte paths;
- extraction goes into a new, empty staging folder; files are created with
  `wx` (never through an existing file or link); each target is checked to
  stay inside the folder before writing and again after `realpath`.

No code from the package runs during install: no lifecycle scripts, no
`import` of the kon. The first code that runs is the migration runner applying
its SQL files, then the API loading the kon.

## The index format

`index.json` (signed by `index.json.minisig`, trusted comment
`kitsuden-index registry=… serial=… sha256=…`):

```json
{
  "format": "kitsuden-kon-index",
  "version": 1,
  "registry": "official",
  "serial": 42,
  "generatedAt": "2026-10-28T20:00:00.000Z",
  "expires": "2026-12-01T00:00:00.000Z",
  "publishers": { "A4B7A487EBEE18B8": { "name": "Kitsuden Team", "publicKey": "RWQ…" } },
  "revokedKeys": [],
  "kons": {
    "kon-comments": {
      "owners": ["A4B7A487EBEE18B8"],
      "description": "…",
      "license": "MIT",
      "repository": "https://…",
      "versions": {
        "1.0.0": {
          "tarball": "packages/kon-comments/kon-comments-1.0.0.tgz",
          "signature": "packages/kon-comments/kon-comments-1.0.0.tgz.minisig",
          "sha256": "…",
          "size": 24487,
          "contentHash": "…",
          "keyId": "A4B7A487EBEE18B8",
          "manifest": {
            "manifest": 1,
            "id": "kon-comments",
            "version": "1.0.0",
            "…": "normalized manifest"
          },
          "publishedAt": "…",
          "yanked": false,
          "yankReason": null
        }
      }
    }
  },
  "advisories": [
    {
      "id": "KKA-2026-0001",
      "kon": "kon-x",
      "versions": "<=1.2.0",
      "severity": "critical",
      "summary": "…",
      "revoked": true,
      "publishedAt": "…"
    }
  ]
}
```

`tarball` and `signature` are paths relative to the index URL; absolute URLs
and `..` are refused, so an index cannot point the client at another host.

## Hosting a registry

A registry is a folder: `index.json`, `index.json.minisig` and `packages/`.

- **Static** (the default): upload the folder as is to GitHub Pages, R2/S3,
  any static host or a git repository (users point `url` at the raw
  `index.json`, or at a local checkout). Nothing has to run on the server.
- **API mode**: any server that answers `GET index.json`,
  `GET index.json.minisig` and the tarball paths the index names. It may
  generate them, but what it serves must be signed by the registry key the
  users configured: the client verifies the same way.
- Every write sets `expires` (30 days), and an expired index is refused
  (freshness: a stale mirror cannot freeze users on an old index forever). A
  registry with nothing new to publish re-signs with `kitsuden kon resign
--registry <folder> --index-key <file> [--expires-days <n>]`, before that date.
- The highest `serial` seen is kept in `kitsuden.kons.lock`, so a fresh checkout
  without a lockfile has no floor yet and only `expires` bounds what it accepts.
  Commit the lockfile.

Keep the registry secret key off the host. Signing happens where `publish`
and `yank` run.

## Security model and limits

- **Root of trust**: the registry public key in `kitsuden.registries.json`.
  Changing it is a reviewed change to the project.
- **What a compromised host can do**: serve old files (refused by `serial`
  once a newer one was seen, and by `expires`), withhold files (installs
  fail), nothing else.
- **What a compromised publisher key can do**: publish new versions of the
  kons it owns, with permissions that the next install or update will show
  (and a widening needs explicit confirmation). The registry operator revokes
  the key (`--revoke-key`) and the affected versions (`--revoke`).
- **What a compromised registry key can do**: everything in that registry.
  Rotate by publishing a new key out of band and updating
  `kitsuden.registries.json`.
- **`--allow-unsigned`** (an index or packages without signatures) is for
  local development only and is **always refused when
  `KITSUDEN_PUBLIC=true`**.
- **Not covered**: kon code is not sandboxed (see the permission prompt);
  the declared permissions are a consent record, not enforcement. The Docker
  installer (`docker/install-kons.mjs`) still installs from a source checkout;
  a build that should use registry kons runs `kitsuden kon sync` on a checkout
  with the lockfile before building.

## Why minisign and not Sigstore

Both were evaluated. The registry uses **Ed25519 publisher keys in the
minisign format**:

|                              | minisign / Ed25519 keys                                                                                                                                       | Sigstore keyless (Fulcio + Rekor, OIDC)                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Offline verification         | Yes: one 32-byte public key                                                                                                                                   | Possible with a bundle and a pinned trusted root (TUF), but the root must be refreshed |
| Dependencies in the verifier | None (node:crypto has Ed25519 and BLAKE2b)                                                                                                                    | sigstore-js and its tree, in the one path that must trust nothing                      |
| Publish from anywhere        | Yes                                                                                                                                                           | Needs an OIDC identity (CI or a browser login)                                         |
| Identity                     | A key the registry lists (trust on the registry's word)                                                                                                       | An email or CI workflow identity, logged publicly                                      |
| Transparency log             | No                                                                                                                                                            | Yes (Rekor)                                                                            |
| Interoperable tooling        | Public keys and signatures follow the minisign format, so `minisign -Vm file -P key` should verify our packages (not yet checked against the minisign binary) | `cosign verify-blob`                                                                   |

The deciding points: verification must work in an air-gapped Docker build and
must not add a dependency tree to the code that decides what is trusted, and
third parties must be able to publish without a CI identity provider. Sigstore
can be added later as a **second** signature (CI provenance) next to the
minisign one, without changing the root of trust.

Secret keys are a JSON file holding a PKCS#8 PEM, encrypted with
AES-256-CBC when `KITSUDEN_SIGNING_PASSPHRASE` is set (not minisign's own
scrypt format); public keys and signatures are standard minisign.

## Command reference

| Command                    | What it does                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kon search [text]`        | Kons in the registry (id, latest version, license)                                                                                                                                                 |
| `kon info <kon>[@range]`   | Versions, yanked/revoked marks, advisories, signer, declared permissions                                                                                                                           |
| `kon add <kon>[@range]…`   | Resolve, verify, prompt, install, lock, migrate. `--yes`, `--accept-wider`, `--dry-run`, `--allow-unsigned`, `--registry`, `--registry-key`, `--enable`, `--force`, `--no-install`, `--no-migrate` |
| `kon update [kon…]`        | Re-resolve within the ranges you asked for (all if none given), same prompt rules                                                                                                                  |
| `kon outdated`             | Current, wanted (within your range), latest; yanked, revoked and advisories                                                                                                                        |
| `kon sync`                 | Install exactly what the lockfile pins                                                                                                                                                             |
| `kon verify [kon…]`        | Installed copies and cached packages vs the lockfile, plus revocations; `--file <tgz> --key <pub>` verifies one package offline                                                                    |
| `kon publish <dir>`        | Pack, sign and add to a local registry folder. `--registry`, `--key`, `--index-key`, `--add-owner`, `--dry-run`                                                                                    |
| `kon yank <kon>@<version>` | Yank or `--undo`; `--advisory`, `--revoke`, `--severity`, `--range`, `--revoke-key`                                                                                                                |
| `kon keygen --out <path>`  | Writes `<path>.pub` and `<path>.key`                                                                                                                                                               |

Exit codes: `0` ok, `1` error (verification failure included), `2` the
migrations failed after install, `3` confirmation required and not given.
