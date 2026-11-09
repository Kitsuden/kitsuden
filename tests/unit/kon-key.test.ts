/**
 * One kon, one identity
 * ============================================================================
 *
 * `kon-games` and `games` are the SAME kon: in the `modules` table rows with
 * and without the prefix coexist, inherited from before the convention. Treating
 * the two forms as different things produced three failures at once:
 *
 *   · WHEN LISTING — the kon came out twice on the Kons screen, with contradictory
 *     states (`kon-blog` on next to `blog` off), because the grimoire list
 *     built its key by stripping the prefix.
 *   · WHEN WRITING — the exact `where(key = ...)` did not find the inherited row
 *     and INSERTED a second one. From then on one or the other won
 *     depending on who asked.
 *   · IN THE MENU — the sidebar compared the string, so an entry
 *     declared as `blog` did not appear even though what was active was `kon-blog`.
 *
 * `lib/seed-modules.ts` had already solved this class for seeding and
 * left it written down. This pins the rule for the other three directions.
 */

import { describe, expect, it } from "vitest";

import {
  searchByKonKey,
  canonicalKey,
  isSameKon,
  mergeByKon,
  type KonInput,
} from "../../apps/api/src/lib/kon-key";

describe("canonicalKey", () => {
  it("strips the kon- prefix", () => {
    expect(canonicalKey("kon-games")).toBe("games");
    expect(canonicalKey("kon-academy-lms")).toBe("academy-lms");
  });

  it("leaves as is what already comes without a prefix", () => {
    expect(canonicalKey("games")).toBe("games");
    expect(canonicalKey("ai-memories")).toBe("ai-memories");
  });

  it("only strips the prefix at the start", () => {
    // "kon" in the middle of the name is not a prefix.
    expect(canonicalKey("my-kon-odd")).toBe("my-kon-odd");
  });

  it("does NOT touch interior hyphens", () => {
    // The original failure also did `.replace(/-/g,"_")`, and turned
    // `kon-broadcast-versus` into `broadcast_versus`: a key that is not the id
    // of anything nor matches any row.
    expect(canonicalKey("kon-broadcast-versus")).toBe("broadcast-versus");
  });
});

describe("isSameKon", () => {
  it("recognizes both forms", () => {
    expect(isSameKon("kon-games", "games")).toBe(true);
    expect(isSameKon("games", "kon-games")).toBe(true);
    expect(isSameKon("kon-blog", "kon-blog")).toBe(true);
  });

  it("does not confuse different kons", () => {
    expect(isSameKon("kon-blog", "kon-blocks")).toBe(false);
    expect(isSameKon("broadcast", "broadcast-moba")).toBe(false);
  });
});

describe("searchByKonKey", () => {
  it("finds the inherited row when asking with a prefix", () => {
    // This is the real case: the manifest says kon-games and the row is `games`.
    const rows = new Map([["games", { key: "games", enabled: true }]]);

    expect(searchByKonKey(rows, "kon-games")?.enabled).toBe(true);
  });

  it("finds the prefixed row when asking without it", () => {
    const rows = new Map([["kon-wiki", { key: "kon-wiki", enabled: false }]]);

    expect(searchByKonKey(rows, "wiki")?.key).toBe("kon-wiki");
  });

  it("the EXACT match wins when both rows exist", () => {
    // If a database already carries both, it has to be deterministic: the one
    // that was asked for is returned, not the first one that shows up when walking the map.
    const rows = new Map([
      ["games", { key: "games", enabled: true }],
      ["kon-games", { key: "kon-games", enabled: false }],
    ]);

    expect(searchByKonKey(rows, "kon-games")?.key).toBe("kon-games");
    expect(searchByKonKey(rows, "games")?.key).toBe("games");
  });

  it("returns undefined if it is in neither form", () => {
    const rows = new Map([["kon-blog", { key: "kon-blog", enabled: true }]]);

    expect(searchByKonKey(rows, "kon-nonexistent")).toBeUndefined();
  });

  it("does not confuse a kon with another that starts the same", () => {
    const rows = new Map([["broadcast-moba", { key: "broadcast-moba", enabled: true }]]);

    expect(searchByKonKey(rows, "kon-broadcast")).toBeUndefined();
  });
});

describe("mergeByKon — the two views do not have the same rule", () => {
  // The return type is annotated by hand: when spreading a `Record<string, unknown>`
  // TypeScript keeps `{ key: string }` and loses `grimoireIds` and company,
  // so `tsc` gave an error on every assertion even though the test passed.
  const kon = (key: string, extra: Record<string, unknown> = {}): KonInput => ({
    key,
    ...extra,
  });

  it("a kon in THREE grimoires comes out ONCE, naming all three", () => {
    // kon-dms is included by Corporate, SharePoint and VekDocs. In the
    // grimoires view it must come out on all three cards; in the Kons view, one entry.
    const registry = [kon("kon-dms", { grimoireId: null })];
    const fromGrimoires = [
      kon("kon-dms", { grimoireId: "grimoire-corporate" }),
      kon("kon-dms", { grimoireId: "grimoire-sharepoint" }),
      kon("kon-dms", { grimoireId: "grimoire-documents" }),
    ];

    const r = mergeByKon(registry, fromGrimoires);

    expect(r.grimoireOnly).toEqual([]);
    expect(r.record).toHaveLength(1);
    expect(r.record[0].grimoireIds).toEqual([
      "grimoire-corporate",
      "grimoire-sharepoint",
      "grimoire-documents",
    ]);
  });

  it("does not keep only the first grimoire", () => {
    // The previous version did `grimoireId ?? g.grimoireId` and kon-dms came out
    // as if it belonged only to Corporate. With seven shared kons today,
    // that is lying in the badge of seven.
    const registry = [kon("kon-members", { grimoireId: "grimoire-corporate" })];
    const r = mergeByKon(registry, [
      kon("kon-members", { grimoireId: "grimoire-viggo" }),
      kon("kon-members", { grimoireId: "grimoire-documents" }),
    ]);

    expect(r.record[0].grimoireIds).toContain("grimoire-corporate");
    expect(r.record[0].grimoireIds).toContain("grimoire-viggo");
    expect(r.record[0].grimoireIds).toContain("grimoire-documents");
  });

  it("matches even if one form carries a prefix and the other does not", () => {
    const registry = [kon("kon-games")];
    const r = mergeByKon(registry, [kon("games", { grimoireId: "grimoire-corporate" })]);

    expect(r.grimoireOnly).toEqual([]);
    expect(r.record[0].grimoireIds).toEqual(["grimoire-corporate"]);
  });

  it("a kon that ONLY comes with one grimoire keeps its entry", () => {
    const r = mergeByKon([kon("kon-blog")], [kon("kon-esports", { grimoireId: "grimoire-viggo" })]);

    expect(r.grimoireOnly).toHaveLength(1);
    expect(r.grimoireOnly[0].key).toBe("kon-esports");
    expect(r.grimoireOnly[0].grimoireIds).toEqual(["grimoire-viggo"]);
  });

  it("that same kon is not duplicated either if two grimoires bring it", () => {
    const r = mergeByKon(
      [],
      [
        kon("kon-esports", { grimoireId: "grimoire-viggo" }),
        kon("kon-esports", { grimoireId: "grimoire-corporate" }),
      ]
    );

    expect(r.grimoireOnly).toHaveLength(1);
    expect(r.grimoireOnly[0].grimoireIds).toEqual(["grimoire-viggo", "grimoire-corporate"]);
  });

  it("does not repeat the same grimoire twice", () => {
    const r = mergeByKon(
      [kon("kon-dms", { grimoireId: "grimoire-documents" })],
      [kon("kon-dms", { grimoireId: "grimoire-documents" })]
    );

    expect(r.record[0].grimoireIds).toEqual(["grimoire-documents"]);
  });

  it("flags accumulate: it is enough for ONE active grimoire to switch it on", () => {
    const r = mergeByKon(
      [kon("kon-crm", { isGrimoireActive: false, enabledByGrimoire: false })],
      [
        kon("kon-crm", { grimoireId: "grimoire-default", isGrimoireActive: false }),
        kon("kon-crm", {
          grimoireId: "grimoire-corporate",
          isGrimoireActive: true,
          enabledByGrimoire: true,
        }),
      ]
    );

    expect(r.record[0].isGrimoireActive).toBe(true);
    expect(r.record[0].enabledByGrimoire).toBe(true);
  });
});
