import { beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "$lib/i18n";

import { formatDateTime } from "./utils";

beforeEach(() => setLocale("en", { reload: false }));

describe("formatDateTime", () => {
  it("writes a moment as the rest of the panel does: medium date, short time, no seconds", () => {
    const text = formatDateTime("2026-11-12T15:06:43");
    expect(text).toMatch(/^Nov 12, 2026, 3:06\sPM$/);
  });
  it("says nothing was there with a dash", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
  });
});
