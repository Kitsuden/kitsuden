/**
 * Realtime — channel authorization and per-row isolation
 * ============================================================================
 *
 * Before this module, `subscribeToChannel` only validated the FORMAT of the
 * channel: any connected client could listen to any table. It was latent
 * (nobody was publishing), but once changes were emitted it would have become the
 * same leak we already closed in GraphQL and in dataset entries.
 *
 * These tests pin down the two guarantees:
 *   1. The gate (canSubscribe) reuses checkReadAccess — deny-by-default.
 *   2. The per-row filter (filterForClient) isolates by owner in the broadcast:
 *      being able to listen to the channel is not enough, each row is evaluated separately.
 */

import { describe, expect, test } from "bun:test";

import {
  canSubscribe,
  filterForClient,
  channelFor,
  resourceOf,
  type ChangeEvent,
  type ResourcePolicy,
} from "../lib/realtime-changes";
import type { PolicyJson, RLSRule, RLSUser } from "../lib/rls-builder";

const alice: RLSUser = { id: "user-alice", role: "user" };
const bob: RLSUser = { id: "user-bob", role: "user" };
const admin: RLSUser = { id: "user-admin", role: "admin" };

const OWNER_RULE: RLSRule[] = [{ field: "ownerId", operator: "eq", value: "{{current_user_id}}" }];

const policyOf = (json: Partial<PolicyJson> | null): ResourcePolicy | null =>
  json ? { policyJson: json as PolicyJson } : null;

const eventFor = (ownerId: string | null): ChangeEvent => ({
  type: "INSERT",
  resource: "products",
  row: { id: "row-1", title: "Keyboard", ownerId, status: "published" },
  at: "2026-07-26T00:00:00.000Z",
});

describe("channels", () => {
  test("channelFor / resourceOf round-trip", () => {
    expect(channelFor("products")).toBe("table:products");
    expect(resourceOf("table:products")).toBe("products");
  });

  test("resourceOf rejects foreign formats (not assumed public)", () => {
    expect(resourceOf("presence:room")).toBeNull();
    expect(resourceOf("table:pro ducts")).toBeNull();
    expect(resourceOf("../../etc/passwd")).toBeNull();
  });
});

describe("canSubscribe — the gate", () => {
  test("resource with NO policy → admin only (deny-by-default)", () => {
    expect(canSubscribe("table:products", alice, null)).toBe(false);
    expect(canSubscribe("table:products", null, null)).toBe(false);
    expect(canSubscribe("table:products", admin, null)).toBe(true);
  });

  test("authenticated → accepts a logged-in user", () => {
    const p = policyOf({ readAccess: "authenticated" });
    expect(canSubscribe("table:products", alice, p)).toBe(true);
  });

  // NOTE: the readAccess REJECTION cases (anonymous under "authenticated",
  // non-admin under "admin") are not asserted here: `permissions.test.ts` stubs
  // `checkReadAccess` to `() => true` with `mock.module`, which in bun patches the
  // module registry globally and irreversibly. Those cases are already
  // covered in `dataset-entries-isolation.test.ts`, which tests
  // `checkReadAccess` directly. Here we verify what is specific to this module:
  // the channel format and per-row isolation.

  test("public → accepts anonymous", () => {
    expect(canSubscribe("table:products", null, policyOf({ readAccess: "public" }))).toBe(true);
  });

  test("a channel with an invalid format is denied even to admin", () => {
    expect(canSubscribe("not-a-channel", admin, policyOf({ readAccess: "public" }))).toBe(false);
  });
});

describe("filterForClient — per-row isolation", () => {
  test("with owner rlsRules, each person sees ONLY their rows", () => {
    const p = policyOf({ readAccess: "authenticated", rlsRules: OWNER_RULE });
    const event = eventFor("user-alice");

    expect(filterForClient(event, alice, p)).not.toBeNull(); // its row
    expect(filterForClient(event, bob, p)).toBeNull(); // someone else's row → NOT delivered
  });

  test("admin sees all rows", () => {
    const p = policyOf({ readAccess: "authenticated", rlsRules: OWNER_RULE });
    expect(filterForClient(eventFor("user-alice"), admin, p)).not.toBeNull();
    expect(filterForClient(eventFor("user-bob"), admin, p)).not.toBeNull();
  });

  test("without rlsRules the channel does not isolate: passing the gate is enough", () => {
    const p = policyOf({ readAccess: "authenticated" });
    expect(filterForClient(eventFor("user-bob"), alice, p)).not.toBeNull();
  });

  test("non-owner rules also filter (drafts excluded)", () => {
    // Audit: only the owner rule was checked, so with
    // `status eq published` the socket also delivered drafts.
    const p = policyOf({
      readAccess: "authenticated",
      rlsRules: [{ field: "visibility", operator: "eq", value: "public" }],
    });
    // A rule over a field of the JSONB `data` (the row's own status column is
    // checked separately, see "drafts" below).
    const withVisibility = (visibility: string): ChangeEvent => ({
      ...eventFor("user-bob"),
      row: { ...eventFor("user-bob").row, data: { visibility } },
    });
    expect(filterForClient(withVisibility("public"), alice, p)).not.toBeNull();
    expect(filterForClient(withVisibility("hidden"), alice, p)).toBeNull();
  });

  test("without a policy, only admin receives", () => {
    expect(filterForClient(eventFor("user-alice"), alice, null)).toBeNull();
    expect(filterForClient(eventFor("user-alice"), admin, null)).not.toBeNull();
  });

  // (The "does not pass the gate → receives no rows" case depends on checkReadAccess,
  // stubbed globally by permissions.test.ts — see the note above. Owner
  // isolation, which is this module's OWN logic, is
  // verified in the tests above and is what prevents the leak between users.)

  test("the ownerId inside data (datasets JSONB) also isolates", () => {
    const p = policyOf({ readAccess: "authenticated", rlsRules: OWNER_RULE });
    const event: ChangeEvent = {
      type: "UPDATE",
      resource: "products",
      row: { id: "row-2", status: "published", data: { ownerId: "user-alice", title: "X" } },
      at: "2026-07-26T00:00:00.000Z",
    };
    expect(filterForClient(event, alice, p)).not.toBeNull();
    expect(filterForClient(event, bob, p)).toBeNull();
  });

  test("a row without an owner is not delivered under isolation (fails closed)", () => {
    const p = policyOf({ readAccess: "authenticated", rlsRules: OWNER_RULE });
    expect(filterForClient(eventFor(null), alice, p)).toBeNull();
  });

  test("an anonymous user never receives rows under owner isolation", () => {
    const p = policyOf({ readAccess: "public", rlsRules: OWNER_RULE });
    expect(filterForClient(eventFor("user-alice"), null, p)).toBeNull();
  });
});

// Security review 2026-11-03: REST and search show a draft only to its owner,
// its creator or the team (`publishedOrOwn`); the socket broadcast it to every
// subscriber of a public dataset.
describe("filterForClient — drafts, like REST and search", () => {
  const editor: RLSUser = { id: "user-editor", role: "editor" };
  const open = policyOf({ readAccess: "public" });
  const draft = (extra: Record<string, unknown>): ChangeEvent => ({
    type: "INSERT",
    resource: "posts",
    row: { id: "d-1", title: "Draft", status: "draft", ...extra },
    at: "2026-11-04T00:00:00.000Z",
  });

  test("a draft reaches its owner, its creator and the team, nobody else", () => {
    expect(filterForClient(draft({ ownerId: "user-alice" }), alice, open)).not.toBeNull();
    expect(filterForClient(draft({ createdById: "user-alice" }), alice, open)).not.toBeNull();
    expect(filterForClient(draft({ owner_id: "user-alice" }), alice, open)).not.toBeNull();
    expect(filterForClient(draft({ ownerId: "user-alice" }), bob, open)).toBeNull();
    expect(filterForClient(draft({ ownerId: "user-alice" }), null, open)).toBeNull();
    expect(filterForClient(draft({ ownerId: "user-alice" }), editor, open)).not.toBeNull();
    expect(filterForClient(draft({ ownerId: "user-alice" }), admin, open)).not.toBeNull();
  });

  test("a row without a status is not published (as in SQL)", () => {
    const e: ChangeEvent = { ...draft({}), row: { id: "x", title: "no status" } };
    expect(filterForClient(e, bob, open)).toBeNull();
  });

  test("a published row whose previous version was a draft: delivered without `previous`", () => {
    const e: ChangeEvent = {
      type: "UPDATE",
      resource: "posts",
      row: { id: "p", status: "published", ownerId: "user-alice", title: "Now public" },
      previous: { id: "p", status: "draft", ownerId: "user-alice", title: "secret draft" },
      at: "2026-11-04T00:00:00.000Z",
    };
    const forBob = filterForClient(e, bob, open);
    expect(forBob).not.toBeNull();
    expect(forBob!.previous).toBeUndefined();
    expect(JSON.stringify(forBob)).not.toContain("secret draft");
    expect(filterForClient(e, alice, open)!.previous).toBeDefined();
  });
});
