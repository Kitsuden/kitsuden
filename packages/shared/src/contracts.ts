/**
 * CONTRACT versions of Kitsuden's public API
 * ============================================================================
 *
 * Kitsuden's version (`0.9.0-beta`, the one in `apps/api/package.json`) says
 * which code is running. It does not say whether an outside client —Inti with
 * `@intijs/adapter-kitsuden`, an alternative panel, a script— still
 * understands what it responds: two Kitsuden versions can speak the
 * same contract, and a single minor version can break it.
 *
 * That is why each surface consumed by someone outside carries its own INTEGER
 * number (a "major" version), which `GET /api/version` publishes as is:
 *
 *   page-builder     /api/page-builder/pages, /pages/:id, /block-types and the
 *                    block writes (POST/PATCH/DELETE, reorder,
 *                    duplicate)
 *   games            reading entries: GET /api/games/slug/:slug and /:id
 *                    (mostly `blocks[]`: id, type, order, data, editorial)
 *   games-editorial  PATCH /api/games/:id/blocks/:blockId/editorial and
 *                    PUT /api/games/:id/blocks/order
 *   admin-registry   GET /api/admin/registry (see admin-registry-contract.ts)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * When a number is bumped (full policy: docs/install/versiones.md)
 *
 * It does NOT bump (compatible):
 *   - adding a field to a response
 *   - adding a new route, or an optional parameter to an existing one
 *   - adding a block type to `/block-types`
 *   - accepting more input forms than were accepted
 *
 * It DOES bump (incompatible):
 *   - removing or renaming a field of a response or a body
 *   - changing its type or meaning (e.g. `sortOrder` stops being a number,
 *     `order` starts counting from 1, `editorial.hidden` changes meaning)
 *   - making something mandatory that was optional in a request
 *   - changing the envelope (`{ blockTypes: [...] }` → bare array)
 *   - removing or moving a route, or changing the status code of a documented
 *     case (404 ↔ 403, 200 ↔ 201)
 *   - requiring a different permission/scope for what was already possible
 *
 * When bumping one: change the number HERE, regenerate the reference responses
 * (`contracts/inti/reference-responses.json`) and note it in
 * the compatibility matrix of docs/install/versiones.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ADMIN_REGISTRY_VERSION } from "./admin-registry-contract";
import { KONS_SDK_VERSION } from "./operations";

/**
 * Semver version of Kitsuden (the API). It must match `version` in
 * `apps/api/package.json` and in the root `package.json`: it is guarded by
 * `tests/unit/inti-contract.test.ts`. It lives here and is not read from package.json
 * because the API is packaged with `bun build` and its tsconfig does not resolve JSON.
 */
export const KITSUDEN_VERSION = "0.9.0-beta";

export const CONTRACTS = {
  "page-builder": 1,
  // 2 (0.9): block data and editorial keys in English (`title`, `description`, `hidden`,
  // `order`…) and the editorial routes under `/blocks/`. See block-keys.ts and the CHANGELOG.
  games: 2,
  "games-editorial": 2,
  "admin-registry": ADMIN_REGISTRY_VERSION,
} as const;

export type ContractName = keyof typeof CONTRACTS;

/**
 * Versions of the CODE contracts (not HTTP): what a third-party kon
 * needs to know to declare itself compatible. Same criterion as `CONTRACTS`
 * (integer, bumped only if something breaks), but in its own field of
 * `GET /api/version` (`sdk`): an HTTP client like Inti does not depend on them.
 *
 *   kons   the operations SDK (`operations.ts`, docs/kons/README.md).
 *          A kon declares it with `sdk: 1` (in its definition or in kon.json);
 *          the loader refuses to mount one that asks for a higher major version.
 */
export const SDKS = {
  kons: KONS_SDK_VERSION,
} as const;

/** What `GET /api/version` responds with */
export interface VersionResponse {
  /** Product name: always "kitsuden" (lets the API be recognized). Up to 0.8: `producto`. */
  product: "kitsuden";
  /** Semver version of the API (the one in `apps/api/package.json`) */
  version: string;
  /** Major version of each public contract. Up to 0.8: `contratos`. */
  contracts: Record<string, number>;
  /** Version of each code contract (`SDKS`): the kon SDK. */
  sdk?: Record<string, number>;
}
