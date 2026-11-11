import { describe, expect, it } from "vitest";

import { postRow, postVisibility, readingMinutes } from "./posts";

const NOW = new Date("2026-11-11T12:00:00Z");

describe("posts list rows", () => {
  it("reading time: 200 words a minute, at least one, none for an empty post", () => {
    expect(readingMinutes("word ".repeat(10))).toBe(1);
    expect(readingMinutes("word ".repeat(401))).toBe(3);
    expect(readingMinutes("   ")).toBeNull();
    expect(readingMinutes(undefined)).toBeNull();
  });

  it("visibility: only a published post whose date has come is live", () => {
    expect(postVisibility("published", "2026-11-01T00:00:00Z", NOW)).toBe("live");
    expect(postVisibility("published", "2026-12-01T00:00:00Z", NOW)).toBe("scheduled");
    expect(postVisibility("scheduled", "2026-12-01T00:00:00Z", NOW)).toBe("scheduled");
    expect(postVisibility("draft", "2026-11-01T00:00:00Z", NOW)).toBe("hidden");
    expect(postVisibility("archived", null, NOW)).toBe("hidden");
    // Published with no date: it is out.
    expect(postVisibility("published", null, NOW)).toBe("live");
  });

  it("a row carries the author's name (or email), the language in capitals and the slug", () => {
    const row = postRow(
      {
        id: 7,
        title: "Guji",
        slug: "guji",
        status: "published",
        locale: "en",
        author: { email: "ana@example.com" },
        content: "one two three",
        publishedAt: "2026-11-01T00:00:00Z",
      },
      NOW
    );
    expect(row).toMatchObject({
      id: "7",
      title: "Guji",
      slug: "guji",
      locale: "EN",
      author: "ana@example.com",
      readingMinutes: 1,
      visibility: "live",
    });
    expect(postRow({ id: 1 }, NOW)).toMatchObject({ status: "draft", locale: "ES", author: null });
  });
});
