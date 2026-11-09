/**
 * Realtime broadcasts: drafts like REST, and the policy as of now
 * ============================================================================
 *
 * Security review 2026-11-03:
 *   · a public dataset broadcast `entry:created/updated` to every subscriber,
 *     drafts included; REST and search apply `publishedOrOwn`;
 *   · the row filter read the policy cache without resolving it: an expired entry
 *     was used as it was, so a tightened policy kept broadcasting under the old one.
 *
 * Against the real wiring (`wireRealtimeAuthorization`) and a real dataset.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { dataSets } from "../db/schema";
import { currentRowFilter } from "../lib/realtime";
import type { ChangeEvent } from "../lib/realtime-changes";
import { invalidateRealtimePolicy, wireRealtimeAuthorization } from "../lib/realtime-wiring";

import { generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
const slug = `rt-drafts-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
const channel = `table:${slug}`;

const event = (status: string, ownerId = "user-alice"): ChangeEvent => ({
  type: "INSERT",
  resource: slug,
  row: { id: generateTestId(), title: "row", status, ownerId, data: {} },
  at: new Date().toISOString(),
});

const filter = async (e: ChangeEvent, user: { id: string | null; role: string | null }) =>
  currentRowFilter()!(channel, e, user as never);

describe("realtime broadcasts", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    await db.insert(dataSets).values({
      name: slug,
      slug,
      schema: [{ key: "n", type: "text" }],
      policyJson: { readAccess: "public", writeAccess: "admin" },
    } as never);
    invalidateRealtimePolicy();
    wireRealtimeAuthorization();
  });

  afterAll(async () => {
    setSystemTime();
    if (!dbAvailable) return;
    await db.delete(dataSets).where(eq(dataSets.slug, slug));
    invalidateRealtimePolicy();
  });

  it("a draft reaches its owner and the team, not other subscribers", async () => {
    if (!dbAvailable) return;
    const bob = { id: "user-bob", role: "user" };
    expect(await filter(event("published"), bob)).not.toBeNull();
    expect(await filter(event("draft"), bob)).toBeNull();
    expect(await filter(event("draft"), { id: null, role: null })).toBeNull();
    expect(await filter(event("draft"), { id: "user-alice", role: "user" })).not.toBeNull();
    expect(await filter(event("draft"), { id: "user-ed", role: "editor" })).not.toBeNull();
  });

  it("the filter resolves the policy: an expired cache entry is not used as is", async () => {
    if (!dbAvailable) return;
    const anonymous = { id: null, role: null };
    // Cached as public
    expect(await filter(event("published"), anonymous)).not.toBeNull();
    // Tightened in the database (no invalidation: e.g. another replica edited it)
    await db
      .update(dataSets)
      .set({ policyJson: { readAccess: "authenticated", writeAccess: "admin" } } as never)
      .where(eq(dataSets.slug, slug));
    // Past the cache's TTL the filter must read it again
    setSystemTime(new Date(Date.now() + 31_000));
    expect(await filter(event("published"), anonymous)).toBeNull();
    expect(await filter(event("published"), { id: "user-bob", role: "user" })).not.toBeNull();
    setSystemTime();
  });

  it("right after an invalidation the filter does not fall back to nothing", async () => {
    if (!dbAvailable) return;
    invalidateRealtimePolicy(slug);
    expect(await filter(event("published"), { id: "user-bob", role: "user" })).not.toBeNull();
  });
});
