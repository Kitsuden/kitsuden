/**
 * The shell's navigation as data: sidebar groups per role, the breadcrumb, the routes that
 * moved, the `g` + letter jumps, the command palette's lists and the recent-records store.
 */
import { describe, expect, it } from "vitest";

import {
  MOVED_ROUTES,
  buildNav,
  currentEntry,
  jumpTargets,
  movedRoute,
  trailFor,
  type NavContext,
} from "./nav";
import {
  createItems,
  isTypingTarget,
  jumpFor,
  matchRows,
  pageItems,
  recentItems,
  recordItems,
} from "./palette";
import { MAX_RECENT, pushRecent, recentStore } from "./recent";

const admin = (over: Partial<NavContext> = {}): NavContext => ({
  isAdmin: true,
  isStaff: true,
  activeKon: () => true,
  kons: [],
  hasOwnScreens: () => false,
  ...over,
});

const ids = (ctx: NavContext) =>
  Object.fromEntries(buildNav(ctx).map((g) => [g.id, g.entries.map((e) => e.id)]));

describe("sidebar groups", () => {
  it("an administrator: Home, Data, Agents, Platform and Settings, in that order", () => {
    const groups = buildNav(admin());
    expect(groups.map((g) => g.id)).toEqual(["home", "data", "agents", "platform", "settings"]);
    expect(ids(admin())).toEqual({
      home: ["home"],
      data: ["datasets", "models", "media", "pages", "blog"],
      agents: ["approvals", "agents", "activity", "connections"],
      platform: ["kons", "actions", "brain", "vault"],
      settings: ["settings"],
    });
    // Home and Settings carry no heading; the others are labelled.
    expect(groups.map((g) => g.labelKey ?? null)).toEqual([
      null,
      "shell.groupData",
      "shell.groupAgents",
      "shell.groupPlatform",
      null,
    ]);
  });

  it("Approvals is the first entry of Agents", () => {
    expect(ids(admin()).agents?.[0]).toBe("approvals");
  });

  it("a disabled kon has no entry", () => {
    const off = admin({ activeKon: (key) => key !== "kon-blog" && key !== "kon-datasets" });
    expect(ids(off).data).toEqual(["models", "media", "pages"]);
  });

  it("generic kons go under Data; kons with their own screens under Apps", () => {
    const ctx = admin({
      kons: [
        { key: "kon-roastery", name: "Roastery", source: "filesystem" },
        { key: "kon-tierlist", name: "Tier lists", icon: "Trophy" },
        { key: "kon-webhooks", name: "Webhooks" },
        { key: "kon-blog", name: "Blog" },
        { key: "kon-off", name: "Off" },
      ],
      activeKon: (key) => key !== "kon-off",
      hasOwnScreens: (key) => key === "kon-tierlist",
    });
    const groups = buildNav(ctx);
    expect(groups.map((g) => g.id)).toEqual([
      "home",
      "data",
      "apps",
      "agents",
      "platform",
      "settings",
    ]);
    expect(ids(ctx).data).toEqual([
      "datasets",
      "models",
      "media",
      "pages",
      "blog",
      "kon:kon-roastery",
    ]);
    expect(ids(ctx).apps).toEqual(["kon:kon-tierlist"]);
    const kon = groups.find((g) => g.id === "apps")!.entries[0]!;
    expect(kon).toMatchObject({ path: "/g/kon-tierlist", label: "Tier lists", icon: "Trophy" });
  });

  it("an editor sees what the API opens to the team, and no Settings", () => {
    const editor = admin({ isAdmin: false, isStaff: true, activeKon: () => false });
    expect(ids(editor)).toEqual({
      home: ["home"],
      data: ["models", "media", "pages", "blog"],
      agents: ["approvals", "connections"],
    });
  });

  it("the entry of a sub-page is the longest match", () => {
    const groups = buildNav(admin());
    expect(currentEntry(groups, "/datasets/abc/entries/1")?.id).toBe("datasets");
    expect(currentEntry(groups, "/g/kon-blog/posts")?.id).toBe("blog");
    expect(currentEntry(groups, "/agents/42")?.id).toBe("agents");
    expect(currentEntry(groups, "/")?.id).toBe("home");
    expect(currentEntry(groups, "/nowhere")).toBeUndefined();
  });
});

describe("breadcrumb", () => {
  it("the section, then what the page adds; the last crumb has no link", () => {
    const section = { label: "Datasets", path: "/datasets" };
    expect(trailFor(section)).toEqual([{ label: "Datasets" }]);
    expect(
      trailFor(section, [{ label: "Products", href: "/datasets/1/entries" }, { label: "Guji" }])
    ).toEqual([
      { label: "Datasets", href: "/datasets" },
      { label: "Products", href: "/datasets/1/entries" },
      { label: "Guji" },
    ]);
    expect(trailFor(undefined)).toEqual([]);
  });
});

describe("routes that moved", () => {
  const to = (path: string) => movedRoute(new URL(`https://x.test${path}`));

  it("every old address lands on its new page", () => {
    expect(to("/traces")).toBe("/activity");
    expect(to("/traces?tab=queue")).toBe("/activity?tab=queue");
    expect(to("/agents/traces")).toBe("/activity?tab=agents");
    expect(to("/oauth/connections")).toBe("/connections");
    expect(to("/mcp-servers")).toBe("/connections?tab=mcp");
    expect(to("/grimoires/")).toBe("/kons?tab=grimoires");
    expect(to("/g/kon-datasets")).toBe("/datasets");
    expect(to("/dashboard")).toBe("/");
  });

  it("a route that did not move, or a sub-route of one, is left alone", () => {
    expect(to("/agents")).toBeNull();
    expect(to("/g/kon-datasets/x")).toBeNull();
    expect(to("/oauth/consent?request=1")).toBeNull();
  });

  it("no moved route points at another moved route", () => {
    const from = new Set(MOVED_ROUTES.map((r) => r.from));
    for (const r of MOVED_ROUTES) expect(from.has(r.to)).toBe(false);
  });
});

describe("g + letter", () => {
  const groups = buildNav(admin());
  const targets = jumpTargets(groups);

  it("every curated entry has its own letter", () => {
    const entries = groups.flatMap((g) => g.entries);
    const letters = entries.map((e) => e.jump);
    expect(letters.every(Boolean)).toBe(true);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("jumps only after g, by letter, in either case", () => {
    expect(jumpFor(true, "d", targets)?.path).toBe("/datasets");
    expect(jumpFor(true, "A", targets)?.path).toBe("/approvals");
    expect(jumpFor(false, "d", targets)).toBeNull();
    expect(jumpFor(true, "9", targets)).toBeNull();
  });

  it("shortcuts stay out of the way while typing", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    editor.append(span);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(span)).toBe(true);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${Object.values(params).join(",")}` : key;

describe("command palette", () => {
  it("lists a page per sidebar entry, with its jump", () => {
    const items = pageItems(buildNav(admin()), t);
    const datasets = items.find((i) => i.id === "page:datasets")!;
    expect(datasets).toMatchObject({
      label: "shell.datasets",
      href: "/datasets",
      shortcut: "g d",
      description: "shell.groupData",
    });
    expect(items).toHaveLength(15);
  });

  it("New … for a dataset, an entry per dataset, a record per model and an agent", () => {
    const items = createItems(
      {
        datasets: [{ id: "d1", name: "Products", slug: "products" }],
        models: [
          {
            kon: "kon-roastery",
            name: "cupping-session",
            plural: "cupping-sessions",
            path: "/models/kon-roastery/cupping-session",
          },
        ],
        isAdmin: true,
        datasetsOn: true,
      },
      t
    );
    expect(items.map((i) => [i.id, i.href])).toEqual([
      ["new:dataset", "/datasets/new"],
      ["new:entry:d1", "/datasets/d1/entries/new"],
      ["new:model:kon-roastery/cupping-session", "/models/kon-roastery/cupping-session/new"],
      ["new:agent", "/agents?new=1"],
    ]);
    const editor = createItems({ datasets: [], models: [], isAdmin: false, datasetsOn: false }, t);
    expect(editor).toEqual([]);
  });

  it("recent records come from the history it is given, not a fixed list", () => {
    expect(recentItems([], t)).toEqual([]);
    expect(
      recentItems([{ path: "/datasets/1/entries/9", label: "Guji", section: "Datasets", at: 1 }], t)
    ).toEqual([
      {
        id: "recent:/datasets/1/entries/9",
        label: "Guji",
        group: "palette.groupRecent",
        description: "Datasets",
        href: "/datasets/1/entries/9",
      },
    ]);
  });

  it("search results keep a record the API matched on another field", () => {
    const items = recordItems(
      [
        {
          source: "Products",
          kind: "dataset",
          href: "/datasets/d/entries/1",
          row: { id: "1", data: { name: "Guji" } },
        },
        {
          source: "Plans",
          kind: "model",
          href: "/models/k/plan/2",
          row: { id: "2", name: "Weekly" },
          titleField: "name",
        },
      ],
      "natural",
      t
    );
    expect(items.map((i) => [i.label, i.description, i.badge])).toEqual([
      ["Guji", "Products", "palette.badgeEntry"],
      ["Weekly", "Plans", "palette.badgeRecord"],
    ]);
    // The palette filters by label and keywords: the query is a keyword of every result.
    expect(items.every((i) => i.keywords?.includes("natural"))).toBe(true);
  });

  it("matchRows: every word must appear somewhere in the row", () => {
    const rows = [
      { id: "1", coffee: "Ethiopia Guji Natural", score: 88 },
      { id: "2", coffee: "Kenya Nyeri AA", score: 87 },
    ];
    expect(matchRows(rows, "guji 88").map((r) => r.id)).toEqual(["1"]);
    expect(matchRows(rows, "kenya guji")).toEqual([]);
    expect(matchRows(rows, "  ")).toEqual([]);
  });
});

describe("recent records", () => {
  it("newest first, one per path, capped", () => {
    let list = pushRecent([], { path: "/a", label: "A", at: 1 });
    list = pushRecent(list, { path: "/b", label: "B", at: 2 });
    list = pushRecent(list, { path: "/a", label: "A renamed", at: 3 });
    expect(list.map((r) => [r.path, r.label])).toEqual([
      ["/a", "A renamed"],
      ["/b", "B"],
    ]);
    for (let i = 0; i < 20; i++) list = pushRecent(list, { path: `/n${i}`, label: `N${i}`, at: i });
    expect(list).toHaveLength(MAX_RECENT);
    expect(pushRecent(list, { path: "/x", label: "  ", at: 9 })).toBe(list);
  });

  it("is kept per user, and survives bad data", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    const ana = recentStore("ana", storage);
    ana.push({ path: "/datasets/1/entries/9", label: "Guji", section: "Datasets" });
    expect(
      recentStore("ana", storage)
        .list()
        .map((r) => r.label)
    ).toEqual(["Guji"]);
    expect(recentStore("luis", storage).list()).toEqual([]);
    data.set("kitsuden-admin-recent:ana", '[{"path":"javascript:alert(1)","label":"x"},7]');
    expect(ana.list()).toEqual([]);
  });
});
