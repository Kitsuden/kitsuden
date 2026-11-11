import { describe, expect, it } from "vitest";

import { registryEntry } from "./registry-entry";
import { requestTraceTime } from "./services/system";

describe("registryEntry", () => {
  it("reads `kon`, which is what the API sends", () => {
    const kon = { id: "kon-directory", views: [] };
    expect(registryEntry({ success: true, contract: 3, kon })).toBe(kon);
  });

  it("still accepts the key from before the rename", () => {
    expect(registryEntry({ grimoire: { id: "x" } })).toEqual({ id: "x" });
  });

  it("is null for a failure, an empty answer or no answer", () => {
    expect(registryEntry({ success: false, error: "nope", kon: { id: "x" } })).toBeNull();
    expect(registryEntry({ success: true })).toBeNull();
    expect(registryEntry(null)).toBeNull();
  });
});

describe("requestTraceTime", () => {
  it("reads `created_at`, the column the API returns", () => {
    expect(requestTraceTime({ created_at: "2026-11-01T10:00:00Z" })).toBe("2026-11-01T10:00:00Z");
  });

  it("falls back to camelCase and to nothing, without throwing", () => {
    expect(requestTraceTime({ createdAt: "2026-11-01T10:00:00Z" } as never)).toBe(
      "2026-11-01T10:00:00Z"
    );
    expect(requestTraceTime({} as never)).toBe("");
  });
});
