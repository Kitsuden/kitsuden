import { describe, expect, it } from "vitest";

import { fieldDiffRedacted, readableFieldDiff } from "./approvals-diff";

describe("a proposal's field diff", () => {
  const diff = { target: { kind: "dataset" }, fields: [{ field: "title" }] };

  it("is returned when it has its fields", () => {
    expect(readableFieldDiff({ fieldDiff: diff as never })?.fields).toHaveLength(1);
    expect(fieldDiffRedacted({ fieldDiff: diff as never })).toBe(false);
  });

  it("is null, not a crash, when the API redacted it", () => {
    const redacted = { redacted: true, reason: "viewer_cannot_approve" };
    expect(readableFieldDiff({ fieldDiff: redacted as never })).toBeNull();
    expect(fieldDiffRedacted({ fieldDiff: redacted as never })).toBe(true);
  });

  it("is null when there is none", () => {
    expect(readableFieldDiff({ fieldDiff: null })).toBeNull();
    expect(readableFieldDiff({})).toBeNull();
    expect(readableFieldDiff(null)).toBeNull();
    expect(fieldDiffRedacted(null)).toBe(false);
  });
});
