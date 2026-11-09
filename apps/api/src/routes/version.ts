/**
 * GET /api/version — which Kitsuden is running and which contracts it speaks
 * ============================================================================
 *
 * Public and sessionless, on purpose: it is queried by clients that have not yet
 * authenticated (the Inti adapter requests it lazily before its
 * first write) and it reveals nothing that cannot be deduced from the API itself.
 * No deployment details (commit, environment, host): only product, semver
 * version and the MAJOR version of each public contract.
 *
 *   { "product": "kitsuden", "version": "0.9.0-beta",
 *     "contracts": { "page-builder": 1, "games": 2, "games-editorial": 2, ... }, "sdk": { ... } }
 *
 * Up to 0.8 the first and third keys were `producto` and `contratos`; readers (the CLI, the Inti
 * adapter) accept both for one version.
 *
 * Only the contracts whose kon is mounted are announced (see CONTRACT_KON).
 * The numbers come from `CONTRACTS` (packages/shared/src/contracts.ts), which is
 * where it is documented when they are bumped. Full policy and compatibility
 * matrix: docs/install/versions.md.
 *
 * Mounting (index.ts, next to /api/health, before any route with auth):
 *
 *   import { versionRoutes } from "./routes/version";
 *   app.route("/api/version", versionRoutes);
 */

import {
  CONTRACTS,
  SDKS,
  KITSUDEN_VERSION,
  type ContractName,
  type VersionResponse,
} from "@kitsuden/shared";
import { Hono } from "hono";

/**
 * The kon that SERVES each contract. Those not listed here belong to the core
 * (always mounted).
 *
 * Before, all were always announced: with kon-games off, `/api/version`
 * said `games: 1` and `/api/games` answered 404, so a client
 * (the Inti adapter) thought it could write and failed later, further along and
 * with an error that did not mention the kon. A contract without its kon is not announced.
 */
export const CONTRACT_KON: Partial<Record<ContractName, string>> = {
  "page-builder": "kon-blocks",
  games: "kon-games",
  "games-editorial": "kon-games",
};

type Availability = (konId: string) => boolean | Promise<boolean>;

/**
 * Who says whether a kon is mounted. Set by `index.ts` after loading the kons
 * (`availableKon` from lib/deferred-kons). If unset —a version router
 * mounted on its own, as in the contract tests— all of them are announced.
 */
let availability: Availability = () => true;

export function setKonAvailability(fn: Availability): void {
  availability = fn;
}

/** The body, separated so it can be tested without mounting the app */
export async function versionResponse(
  isAvailable: Availability = availability
): Promise<VersionResponse> {
  const contracts: Record<string, number> = {};
  for (const [name, version] of Object.entries(CONTRACTS) as [ContractName, number][]) {
    const kon = CONTRACT_KON[name];
    if (kon && !(await isAvailable(kon))) continue;
    contracts[name] = version;
  }
  return {
    product: "kitsuden",
    version: KITSUDEN_VERSION,
    contracts,
    sdk: { ...SDKS },
  };
}

export const versionRoutes = new Hono();

versionRoutes.get("/", async (c) => {
  // Changes on deployment or when a kon is activated/deactivated: short cache time
  c.header("Cache-Control", "public, max-age=60");
  return c.json(await versionResponse());
});
