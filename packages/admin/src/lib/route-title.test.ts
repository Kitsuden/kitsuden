import { describe, expect, it } from "vitest";

import en from "./i18n/en";
import { navItemMatches, routeTitleKey } from "./route-title";

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

describe("routeTitleKey", () => {
  const cases: Array<[string, string | null]> = [
    ["/", "common.dashboard"],
    ["/dashboard", "common.dashboard"],
    ["/datasets", "common.datasets"],
    ["/datasets/new", "titles.newDataset"],
    ["/datasets/abc/entries", "titles.entries"],
    ["/datasets/abc/edit", "titles.editDataset"],
    ["/agents", "titles.agents"],
    ["/agents/traces", "titles.agentTraces"],
    ["/agents/abc", "titles.agent"],
    ["/settings/", "common.settings"],
    ["/g/kon-blog", null],
  ];
  it.each(cases)("%s → %s", (path, key) => {
    expect(routeTitleKey(path)).toBe(key);
  });

  it("every key it can return exists in the dictionary", () => {
    const dic = en as Record<string, Record<string, string>>;
    for (const [path] of cases) {
      const key = routeTitleKey(path);
      if (!key) continue;
      const [ns, name] = key.split(".");
      expect(dic[ns]?.[name], key).toBeTruthy();
    }
  });
});
