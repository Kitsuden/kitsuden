/**
 * The panel's navigation, as data: the sidebar groups, the breadcrumb of a route, the
 * routes that moved, and the `g` + letter jumps. The shell, the command palette and the
 * shortcuts sheet all read it from here, so an entry is declared once.
 *
 *   Home
 *   DATA      Datasets, Models, Media, Pages, Blog + the generic kons (tables the panel draws)
 *   APPS      kons that bring their own screens (only when there are any)
 *   AGENTS    Approvals, Agents, Activity, Connections
 *   PLATFORM  Kons, Actions, Brain, Vault
 *   Settings
 */
import { navItemMatches } from "./route-title";

export type NavGroupId = "home" | "data" | "apps" | "agents" | "platform" | "settings";

export interface NavEntry {
  /** Stable id (the Sidebar item's id). */
  id: string;
  path: string;
  /** i18n key of the label, or the label itself for a kon discovered at run time. */
  labelKey?: string;
  label?: string;
  /** A lucide icon name known to the shell, or a kon's own icon (name or emoji). */
  icon: string;
  /** The kon that must be enabled for the entry to show. */
  moduleKey?: string;
  /** An editor sees it too (the API opens it to the team). */
  staff?: boolean;
  /** Other paths that belong to this entry. */
  aliases?: string[];
  /** The letter after `g` that jumps here. */
  jump?: string;
}

export interface NavGroup {
  id: NavGroupId;
  /** i18n key of the group's heading; none for Home and Settings. */
  labelKey?: string;
  entries: NavEntry[];
}

/** A kon as the module list describes it (the part the menu needs). */
export interface NavKon {
  key: string;
  name?: string;
  icon?: string;
  source?: string;
}

export interface NavContext {
  isAdmin: boolean;
  isStaff: boolean;
  /** Whether a kon is enabled (`moduleStore.activeKon`). */
  activeKon: (key: string) => boolean;
  /** Every kon the API listed. */
  kons: NavKon[];
  /** Kons that bring their own screens; the rest are drawn by the panel (generic). */
  hasOwnScreens: (key: string) => boolean;
}

const HOME: NavEntry = {
  id: "home",
  path: "/",
  labelKey: "shell.home",
  icon: "LayoutDashboard",
  aliases: ["/dashboard"],
  jump: "h",
};

const DATA: NavEntry[] = [
  {
    id: "datasets",
    path: "/datasets",
    labelKey: "shell.datasets",
    icon: "Table2",
    aliases: ["/g/kon-datasets", "/collections"],
    moduleKey: "kon-datasets",
    jump: "d",
  },
  {
    id: "models",
    path: "/models",
    labelKey: "shell.models",
    icon: "Boxes",
    staff: true,
    jump: "m",
  },
  {
    id: "media",
    path: "/g/kon-media",
    labelKey: "shell.media",
    icon: "ImageIcon",
    moduleKey: "kon-media",
    staff: true,
    jump: "i",
  },
  {
    id: "pages",
    path: "/g/kon-blocks",
    labelKey: "shell.pages",
    icon: "Blocks",
    moduleKey: "kon-blocks",
    staff: true,
    jump: "p",
  },
  {
    id: "blog",
    path: "/g/kon-blog",
    labelKey: "shell.blog",
    icon: "FileText",
    aliases: ["/content"],
    moduleKey: "kon-blog",
    staff: true,
    jump: "b",
  },
];

const AGENTS: NavEntry[] = [
  {
    id: "approvals",
    path: "/approvals",
    labelKey: "shell.approvals",
    icon: "ShieldCheck",
    staff: true,
    jump: "a",
  },
  { id: "agents", path: "/agents", labelKey: "shell.agents", icon: "Bot", jump: "g" },
  {
    id: "activity",
    path: "/activity",
    labelKey: "shell.activity",
    icon: "Activity",
    jump: "t",
  },
  {
    id: "connections",
    path: "/connections",
    labelKey: "shell.connections",
    icon: "Plug",
    staff: true,
    jump: "c",
  },
];

const PLATFORM: NavEntry[] = [
  { id: "kons", path: "/kons", labelKey: "shell.kons", icon: "Book", jump: "k" },
  { id: "actions", path: "/actions", labelKey: "shell.actions", icon: "Zap", jump: "x" },
  { id: "brain", path: "/brain", labelKey: "shell.brain", icon: "Brain", jump: "r" },
  { id: "vault", path: "/vault", labelKey: "shell.vault", icon: "Archive", jump: "v" },
];

const SETTINGS: NavEntry = {
  id: "settings",
  path: "/settings",
  labelKey: "shell.settings",
  icon: "Settings",
  jump: "s",
};

/** Kons that are infrastructure of another screen (Settings, Actions), never a menu entry. */
const INFRA_KONS = new Set(["webhooks", "connectors", "ai-memories"]);

const bare = (key: string) => key.replace(/^kon-/, "");

/**
 * Routes that moved when the sidebar was regrouped. The old address still works: the
 * layout replaces it with the new one (query string kept, `tab` added where the old page
 * became a tab).
 */
export const MOVED_ROUTES: Array<{ from: string; to: string; tab?: string }> = [
  { from: "/traces", to: "/activity" },
  { from: "/agents/traces", to: "/activity", tab: "agents" },
  { from: "/oauth/connections", to: "/connections" },
  { from: "/mcp-servers", to: "/connections", tab: "mcp" },
  { from: "/grimoires", to: "/kons", tab: "grimoires" },
  { from: "/g/kon-datasets", to: "/datasets" },
  { from: "/collections", to: "/datasets" },
  { from: "/dashboard", to: "/" },
];

/** Where a moved route lives now (path + query), or null when `url` did not move. */
export function movedRoute(url: URL): string | null {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const hit = MOVED_ROUTES.find((r) => r.from === path);
  if (!hit) return null;
  const params = new URLSearchParams(url.search);
  // `/traces?tab=queue` keeps its tab; a route that became a tab names it.
  if (hit.tab && !params.has("tab")) params.set("tab", hit.tab);
  const query = params.toString();
  return `${hit.to}${query ? `?${query}` : ""}`;
}

/** The sidebar for this user: groups in order, empty ones dropped. */
export function buildNav(ctx: NavContext): NavGroup[] {
  const curated = new Set(DATA.filter((e) => e.moduleKey).map((e) => bare(e.moduleKey!)));

  /**
   * An editor cannot read /api/modules (admin only), so the panel does not know which kons
   * are on: they see the entries the API opens to the team.
   */
  const visible = (e: NavEntry): boolean => {
    if (!ctx.isAdmin) return ctx.isStaff && e.staff === true;
    return !e.moduleKey || ctx.activeKon(e.moduleKey);
  };

  const konEntries: NavEntry[] = ctx.isAdmin
    ? ctx.kons
        .filter(
          (k) =>
            ctx.activeKon(k.key) &&
            !curated.has(bare(k.key)) &&
            !INFRA_KONS.has(bare(k.key)) &&
            (k.key.startsWith("kon-") || k.source === "filesystem" || k.source === "grimoire")
        )
        .map((k) => ({
          id: `kon:${k.key}`,
          path: `/g/${k.key}`,
          label: k.name || bare(k.key),
          icon: k.icon ?? "PackageOpen",
          moduleKey: k.key,
        }))
        .sort((a, b) => a.label!.localeCompare(b.label!))
    : [];

  const groups: NavGroup[] = [
    { id: "home", entries: [HOME] },
    {
      id: "data",
      labelKey: "shell.groupData",
      entries: [
        ...DATA.filter(visible),
        ...konEntries.filter((e) => !ctx.hasOwnScreens(e.moduleKey!)),
      ],
    },
    {
      id: "apps",
      labelKey: "shell.groupApps",
      entries: konEntries.filter((e) => ctx.hasOwnScreens(e.moduleKey!)),
    },
    { id: "agents", labelKey: "shell.groupAgents", entries: AGENTS.filter(visible) },
    { id: "platform", labelKey: "shell.groupPlatform", entries: PLATFORM.filter(visible) },
    { id: "settings", entries: ctx.isAdmin ? [SETTINGS] : [] },
  ];
  return groups.filter((g) => g.entries.length > 0);
}

export const allEntries = (groups: NavGroup[]): NavEntry[] => groups.flatMap((g) => g.entries);

/** The entry `path` belongs to: the longest matching one, so a sub-page keeps its section lit. */
export function currentEntry(groups: NavGroup[], path: string): NavEntry | undefined {
  return allEntries(groups)
    .filter((e) => navItemMatches(e, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The breadcrumb of a page: its section, then what the page adds (`extra`: a dataset, a
 * record). The last crumb is where you are and carries no link. This is the one source of
 * the top bar's trail and of `<title>`.
 */
export function trailFor(
  entry: { label: string; path: string } | undefined,
  extra: Crumb[] = []
): Crumb[] {
  const trail: Crumb[] = entry ? [{ label: entry.label, href: entry.path }, ...extra] : [...extra];
  if (trail.length === 0) return [];
  const last = trail[trail.length - 1]!;
  return [...trail.slice(0, -1), { label: last.label }];
}

/** The `g` + letter jumps available to this user: letter → path. */
export function jumpTargets(groups: NavGroup[]): Map<string, NavEntry> {
  const map = new Map<string, NavEntry>();
  for (const e of allEntries(groups)) if (e.jump && !map.has(e.jump)) map.set(e.jump, e);
  return map;
}
