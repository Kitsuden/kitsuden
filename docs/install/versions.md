# Versions and compatibility (Kitsuden ↔ Inti)

Kitsuden and the Inti packages (`@intijs/*`) live in different repositories
and neither is published on npm (Inti is installed from git at a pinned
commit). Each has its own semver version, and between them something else
rules: the **contract version** of each API surface that an outside client
uses.

## `GET /api/version`

Public, no session, no deployment details:

```json
{
  "product": "kitsuden",
  "version": "0.9.0-beta",
  "contracts": { "page-builder": 1, "games": 2, "games-editorial": 2, "admin-registry": 1 },
  "sdk": { "kons": 1 }
}
```

(Up to 0.8 `product` and `contracts` were `producto` and `contratos`. The CLI and
`@intijs/adapter-kitsuden` accept both names until 0.10.)

- `version`: semver of the API (the version constant in
  `packages/shared/src/contracts.ts`; keep it equal to `version` in
  `apps/api/package.json` and in the root `package.json`).
- `contracts`: **major** version (an integer) of each contract, from
  `CONTRACTS` in the same file. Only the contracts this installation actually
  **serves** appear: with `kon-blocks` disabled there is no `page-builder`,
  and with `kon-games` disabled there is no `games` or `games-editorial` (the
  contract → kon map is `CONTRACT_KON` in `apps/api/src/routes/version.ts`;
  the Inti adapter keeps a copy to say which kon to enable).
- `sdk`: the version of the code contracts, currently `{ "kons": 1 }`: the kon
  SDK, which a kon declares in its `sdk` field.

| Contract          | Routes                                                                                                                                                                                                     | Client                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `page-builder`    | `GET /api/page-builder/pages`, `/pages/:id` (uuid or slug), `/block-types`; `POST /pages/:pageId/blocks`, `PATCH`/`DELETE /blocks/:id`, `POST /pages/:pageId/blocks/reorder`, `POST /blocks/:id/duplicate` | `@intijs/adapter-kitsuden` |
| `games`           | `GET /api/games/slug/:slug`, `GET /api/games/:id` (especially `blocks[]`: `id`, `type`, `order`, `data`, `editorial`)                                                                                      | adapter, websites          |
| `games-editorial` | `PATCH /api/games/:id/blocks/:blockId/editorial`, `PUT /api/games/:id/blocks/order` (body keys `title`, `description`, `hidden`)                                                                           | adapter                    |
| `admin-registry`  | `GET /api/admin/registry` (header `X-Kitsuden-Contract`)                                                                                                                                                   | alternative admin panels   |

## Policy

### Kitsuden API (semver)

- **patch** (`0.9.1`): fixes without contract changes.
- **minor** (`0.10.0`): new features; contracts only grow in a compatible way.
  While Kitsuden is `0.x`, a minor **may** bump a contract (semver allows
  breaking in 0.x), and the release notes say so.
- **major** (`1.0.0` → `2.0.0`): whenever any contract is bumped, from 1.0 on.

### What is an incompatible contract change

It bumps the contract's number (in `CONTRACTS`):

- removing or renaming a field of a response or a request body;
- changing its type or its **meaning** (`sortOrder` no longer a number,
  `order` starting at 1, `editorial.hidden` inverted);
- making something required that was optional in a request;
- changing the envelope of a response (`{ "blockTypes": [...] }` → array);
- removing or moving a route, or changing the status code of a documented
  case (404 ↔ 403, 200 ↔ 201);
- requiring another permission or scope for something already allowed.

It does **not** bump it (compatible): adding fields to a response, new routes,
optional parameters, new block types in `/block-types`, accepting more input
shapes. A client must ignore what it does not know.

A **new** contract appears in `contracts`; a **retired** one disappears (and a
client that needs it must treat that as incompatible).

### `@intijs/*` (semver)

- `@intijs/adapter-kitsuden` declares which versions of each contract it
  understands (`SUPPORTED_CONTRACTS`, `[min, max]`). Supporting a new version
  **in addition** to the previous ones is a minor; dropping one is a major.
- In `0.x`, a minor may break (and the changelog says so).
- `@intijs/core` follows its own semver; its relation with Kitsuden always
  goes through the adapter.

### What the adapter does with all this

Lazily: building the adapter and **reading** do not query anything. Before
the **first write** it asks `/api/version` once:

| The API answers                                                      | The adapter                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| contracts within `SUPPORTED_CONTRACTS`                               | writes                                                                                                      |
| a contract the write uses **above** the supported one                | does not write; error asking to update `@intijs/adapter-kitsuden`                                           |
| a contract **below** the minimum                                     | does not write; error asking to update Kitsuden                                                             |
| does not declare a contract the write needs (e.g. `games-editorial`) | does not write that part; the error names the kon that serves it (usually it is disabled). The rest goes on |
| 404/405 (Kitsuden without the route)                                 | **warns** once and writes                                                                                   |
| network error, 5xx or something that is not Kitsuden                 | warns, writes, and asks again on the next write                                                             |

`checkCompatibility: false` turns the check off; `adapter.checkCompatibility()` runs it by hand (for example, at
start).

## Compatibility matrix

| `@intijs/adapter-kitsuden` | understands `page-builder` / `games` / `games-editorial` | Kitsuden                                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.x (with the check)     | 1 / 2 / 2                                                | 0.9.0-beta: checked. A 0.8 Kitsuden (`games` and `games-editorial` v1, Spanish keys and `/bloques/` routes) is read-only for it: writes to game pages stop with `KitsudenIncompatibleError` before anything is written |

`games` and `games-editorial` went from 1 to 2 in 0.9.0-beta: block data and editorial keys are
English (`title`, `description`, `hidden`, `order`…, the full table is in the CHANGELOG and in
`packages/shared/src/block-keys.ts`) and the editorial routes moved to
`/api/games/:id/blocks/:blockId/editorial` and `/api/games/:id/blocks/order`. A write with a 0.8
key is a 422 whose `hint` names the English key; data stored with 0.8 keys is migrated and, until
0.10, still read.

When a contract is bumped, add a new row here (and in Inti's documentation,
`apps/docs/src/content/docs/adapters/kitsuden.mdx`).

## Reference responses

So that "still compatible" does not depend on memory,
`packages/shared/contracts/inti/reference-responses.json` holds **real**
responses of the page-builder and games routes and of `/api/version`. The Inti
adapter's own tests read, order and write against those responses and bodies,
and keep a copy.

When an API change is **intended**:

1. if it is incompatible, bump the contract in `packages/shared/src/contracts.ts`;
2. update `reference-responses.json` so it matches what the routes now return;
3. copy it to the adapter's tests (`packages/adapter-kitsuden/tests/contract/`
   in the Inti repository) and adjust whatever the adapter no longer
   understands.

The kons repository regenerates it from the live routes
(`UPDATE_INTI_CONTRACT=1 npx vitest run tests/unit/inti-contract.test.ts` there, with this
checkout linked at `.kitsuden`): the games routes belong to `kon-games`, which lives in that
repository.
