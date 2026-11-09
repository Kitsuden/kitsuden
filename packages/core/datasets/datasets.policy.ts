/**
 * DataSets — Authorization Policy
 * ============================================================================
 *
 * Deny-by-default. Importing this module registers the "dataset" and
 * "dataset-entry" policies.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The kon's routes only asked for a SESSION (`requireAuth`), and account
 * sign-up is public. With a newly created account you could: rewrite or delete
 * any entry of any dataset (the game data of the three
 * sites), create datasets, change the `policyJson` of someone else's (mass
 * assignment in `PATCH`), export everything bypassing the read policy, and
 * save calculated fields, which were run with `new Function`.
 *
 * The model now:
 *   · Dataset definition (create, edit, calculated fields, snapshots,
 *     export): the TEAM (`admin`/`editor`). The policy (`policyJson`) can only
 *     be changed by `admin`, because it decides who sees what.
 *   · Deleting a dataset, importing and touching indexes: `admin` only.
 *   · Read: the team always; everyone else according to `policyJson.readAccess`.
 *   · Entries: the team in any dataset; everyone else ONLY where
 *     `policyJson.writeAccess` allows it, and to edit or delete, only their
 *     own (`owner_id`).
 *
 * An agent (`role: "agent"`) passes with the scope `dataset:<action>` or
 * `dataset-entry:<action>` (see `can` in the engine).
 *
 * PER-DATASET scopes (`datasets:<slug>:read|write|delete`, with
 * wildcards `datasets:*:read`): they open THAT dataset for the agent even if its
 * `policyJson` does not, and a denial (`!datasets:<slug>:*`) closes it
 * even if the policy opened it. What is seen INSIDE is still filtered by the
 * policy's `rlsRules` and by Postgres RLS. See docs/agents/permissions.md.
 */
import { can, definePolicy, type AuthzUser } from "@kitsuden/engine";
import {
  accessToDataset,
  agentWritesByPolicy,
  checkReadAccess,
  checkWriteAccess,
  datasetScope,
  type DatasetAction,
  type PolicyJson,
  type RLSUser,
} from "@kitsuden/shared";

export interface DatasetResource {
  id?: string;
  policyJson?: unknown;
}

export interface EntryResource {
  dataset: DatasetResource;
  entry?: { ownerId?: string | null } | null;
}

export const isStaff = (user: AuthzUser | null | undefined): boolean =>
  user?.role === "admin" || user?.role === "editor";

const isAdmin = (user: AuthzUser | null | undefined): boolean => user?.role === "admin";

const asRls = (user: AuthzUser | null): RLSUser =>
  user?.id ? { id: String(user.id), role: user.role } : null;

const policy = (ds: DatasetResource | undefined): PolicyJson | null =>
  (ds?.policyJson ?? null) as PolicyJson | null;

/** Can this (non-team) user write entries according to the policy? */
const writesByPolicy = (user: AuthzUser | null, ds: DatasetResource | undefined): boolean => {
  if (!user?.id) return false;
  // An agent key is not a session: `writeAccess: "authenticated"` alone does not
  // let a read-only key write (the grants by scope are decided after this rule).
  if (user.role === "agent") return agentWritesByPolicy(user.scopes, policy(ds));
  return checkWriteAccess(policy(ds), asRls(user));
};

export function registerDatasetsPolicy(): void {
  definePolicy<DatasetResource>("dataset", {
    view: (user, ds) => isStaff(user) || checkReadAccess(policy(ds), asRls(user)),
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    /** Change `policyJson`: who reads and who writes. */
    "change-policy": (user) => isAdmin(user),
    delete: (user) => isAdmin(user),
    export: (user) => isStaff(user),
    import: (user) => isAdmin(user),
    "manage-indexes": (user) => isAdmin(user),
  });

  definePolicy<EntryResource>("dataset-entry", {
    create: (user, r) => isStaff(user) || writesByPolicy(user, r?.dataset),
    update: (user, r) =>
      isStaff(user) ||
      (writesByPolicy(user, r?.dataset) &&
        !!r?.entry?.ownerId &&
        r.entry.ownerId === String(user?.id)),
    delete: (user, r) =>
      isStaff(user) ||
      (writesByPolicy(user, r?.dataset) &&
        !!r?.entry?.ownerId &&
        r.entry.ownerId === String(user?.id)),
  });
}

registerDatasetsPolicy();

/** `datasets:<slug>:<action>` of the resource a handler passes to `authorize()`. */
export function datasetScopeOf(resource: unknown, action: DatasetAction): string | null {
  const r = resource as { slug?: unknown; dataset?: { slug?: unknown } } | null | undefined;
  const slug =
    typeof r?.dataset?.slug === "string"
      ? r.dataset.slug
      : typeof r?.slug === "string"
        ? r.slug
        : null;
  return slug ? datasetScope(slug, action) : null;
}

/**
 * Can this user READ the dataset (or, with `forAction`, reach it in order
 * to write)? First the agent's per-dataset scopes (deny wins; grant
 * opens), and if they say nothing, the policy.
 */
export async function canViewDataset(
  user: AuthzUser | null,
  ds: DatasetResource & { slug?: string | null },
  /** To write: `datasets:<slug>:write` (or `delete`) also lets you REACH the dataset. */
  forAction?: DatasetAction
): Promise<boolean> {
  const access = accessToDataset(user?.scopes, ds.slug ?? null, "read");
  if (access === "denied") return false;
  if (access === "granted") return true;
  if (forAction && accessToDataset(user?.scopes, ds.slug ?? null, forAction) === "granted")
    return true;
  return can(user, "view", ds, "dataset");
}
