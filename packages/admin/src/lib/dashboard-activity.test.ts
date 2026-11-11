import { describe, expect, it } from "vitest";

import { activityLabel, newestFirst, readableCode } from "./dashboard-activity";
import en from "./i18n/en";
import es from "./i18n/es";

describe("newestFirst", () => {
  it("orders by the moment, not by the text shown", () => {
    const now = Date.now();
    const items = [
      { id: "160d", at: new Date(now - 160 * 86_400_000).toISOString() },
      { id: "10m", at: new Date(now - 10 * 60_000).toISOString() },
      { id: "2h", at: new Date(now - 2 * 3_600_000).toISOString() },
    ];
    // As strings "10m ago" < "160d ago" < "2h ago": the old order.
    expect(newestFirst(items).map((i) => i.id)).toEqual(["10m", "2h", "160d"]);
  });

  it("an entry with no date or a bad one goes last and nothing throws", () => {
    const items = [
      { id: "none", at: null },
      { id: "bad", at: "not a date" },
      { id: "ok", at: "2026-01-01T00:00:00Z" },
    ];
    expect(newestFirst(items).map((i) => i.id)).toEqual(["ok", "none", "bad"]);
  });
});

describe("activityLabel", () => {
  const labels = en.activity as Record<string, string>;
  const t = (key: string) => labels[key.slice("activity.".length)] ?? key;

  it("uses the dictionary for the codes the API writes", () => {
    expect(activityLabel("auth_success", t)).toBe(en.activity.auth_success);
    expect(activityLabel("tool_call", t)).not.toContain("_");
  });

  it("falls back to a readable version of an unknown code", () => {
    expect(activityLabel("some_new_code", t)).toBe("Some new code");
    expect(readableCode("kon:blog.create-post")).toBe("Kon blog create post");
  });

  it("has a text for a missing code", () => {
    expect(activityLabel(undefined, t)).toBe(en.activity.unknown);
  });

  it("both languages label the same codes", () => {
    expect(Object.keys(es.activity).sort()).toEqual(Object.keys(en.activity).sort());
  });
});
