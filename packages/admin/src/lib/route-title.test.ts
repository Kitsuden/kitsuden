import { describe, expect, it } from "vitest";

import { navItemMatches } from "./route-title";

const dashboard = { path: "/", aliases: ["/dashboard"] };
const datasets = { path: "/g/kon-datasets", aliases: ["/datasets"] };
const agents = { path: "/agents" };

describe("navItemMatches", () => {
  it("the dashboard is active on / and /dashboard only", () => {
    expect(navItemMatches(dashboard, "/")).toBe(true);
    expect(navItemMatches(dashboard, "/dashboard")).toBe(true);
    expect(navItemMatches(dashboard, "/datasets")).toBe(false);
    expect(navItemMatches(dashboard, "/dashboards")).toBe(false);
  });

  it("Datasets is active on its kon page and on every /datasets screen", () => {
    for (const path of [
      "/g/kon-datasets",
      "/datasets",
      "/datasets/",
      "/datasets/new",
      "/datasets/5605b478/entries",
      "/datasets/5605b478/edit",
    ]) {
      expect(navItemMatches(datasets, path), path).toBe(true);
    }
    expect(navItemMatches(datasets, "/g/kon-datasets-extra")).toBe(false);
  });

  it("matches whole segments", () => {
    expect(navItemMatches(agents, "/agents/42")).toBe(true);
    expect(navItemMatches(agents, "/agents-old")).toBe(false);
  });
});
