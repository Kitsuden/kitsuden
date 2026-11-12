import { describe, expect, it } from "vitest";

import { academyHref } from "./links";

describe("Academy links", () => {
  it("lead to the kon's grid views and record pages, never to an /academy route", () => {
    expect(academyHref("grid-courses")).toBe("/g/kon-academy-lms/grid-courses");
    expect(academyHref("grid-courses", "c1")).toBe("/g/kon-academy-lms/grid-courses/c1");
    expect(academyHref("grid-learning-paths", "p 1")).toBe(
      "/g/kon-academy-lms/grid-learning-paths/p%201"
    );
    expect(academyHref("grid-groups", "g1").startsWith("/academy/")).toBe(false);
  });
});
