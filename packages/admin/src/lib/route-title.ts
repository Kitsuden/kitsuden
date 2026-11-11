/**
 * What the shell knows about a route without rendering it: which menu entry it belongs
 * to and what the page is called.
 */

/** A menu entry: its own path plus other paths that belong to it. */
export interface NavTarget {
  path: string;
  aliases?: string[];
}

function under(base: string, path: string): boolean {
  if (base === "/") return path === "/";
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Whether `path` belongs to the entry. A whole segment has to match: `/agents` lights up
 * on `/agents/123`, not on `/agents-old`. The dashboard is `/` and its alias `/dashboard`;
 * Datasets is `/g/kon-datasets` and everything under `/datasets`.
 */
export function navItemMatches(item: NavTarget, path: string): boolean {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return [item.path, ...(item.aliases ?? [])].some((base) => under(base, clean));
}

/** Route → i18n key of the page name. First match wins, so the specific ones go first. */
const TITLES: Array<[RegExp, string]> = [
  [/^\/(dashboard)?$/, "common.dashboard"],
  [/^\/datasets\/new$/, "titles.newDataset"],
  [/^\/datasets\/[^/]+\/edit$/, "titles.editDataset"],
  [/^\/datasets\/[^/]+\/entries$/, "titles.entries"],
  [/^\/datasets$/, "common.datasets"],
  [/^\/collections$/, "common.datasets"],
  [/^\/content\/edit$/, "titles.editPost"],
  [/^\/agents\/traces$/, "titles.agentTraces"],
  [/^\/agents\/[^/]+$/, "titles.agent"],
  [/^\/agents$/, "titles.agents"],
  [/^\/approvals$/, "titles.approvals"],
  [/^\/traces$/, "titles.systemTraces"],
  [/^\/actions$/, "common.actions"],
  [/^\/brain$/, "titles.brain"],
  [/^\/vault$/, "titles.vault"],
  [/^\/models$/, "titles.models"],
  [/^\/kons$/, "titles.kons"],
  [/^\/grimoires$/, "titles.grimoires"],
  [/^\/mcp-servers$/, "titles.mcpServers"],
  [/^\/oauth\/connections$/, "titles.oauthConnections"],
  [/^\/oauth\/consent$/, "titles.oauthConsent"],
  [/^\/directory\/org-chart$/, "titles.orgChart"],
  [/^\/admin\/connectors$/, "titles.connectors"],
  [/^\/settings$/, "common.settings"],
];

/** The i18n key of the page's name, or null when the route has no fixed name (a kon's page). */
export function routeTitleKey(path: string): string | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return TITLES.find(([re]) => re.test(clean))?.[1] ?? null;
}
