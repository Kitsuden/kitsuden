/**
 * What the command palette lists, as data: pages (with their `g` + letter jump), "New …"
 * actions, recently opened records and the records a search found. The component only
 * draws these; the rules are here so they can be tested.
 */
import { recordTitle } from "./list/record-title";
import type { NavEntry, NavGroup } from "./nav";
import type { RecentItem } from "./recent";

/** tallao's CommandItem, the part the palette fills. */
export interface PaletteItem {
  id: string;
  label: string;
  group?: string;
  keywords?: string[];
  description?: string;
  shortcut?: string;
  badge?: string;
  href?: string;
  onSelect?: () => void;
}

export interface PaletteDataset {
  id: string;
  name: string;
  slug?: string;
}

export interface PaletteModel {
  kon: string;
  name: string;
  plural: string;
  /** Its list page (`/models/<kon>/<name>`). */
  path: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

const labelOf = (entry: NavEntry, t: Translate) =>
  entry.label ?? (entry.labelKey ? t(entry.labelKey) : entry.id);

/** One item per sidebar entry, in the sidebar's order. */
export function pageItems(groups: NavGroup[], t: Translate): PaletteItem[] {
  return groups.flatMap((group) =>
    group.entries.map((entry) => ({
      id: `page:${entry.id}`,
      label: labelOf(entry, t),
      group: t("palette.groupPages"),
      description: group.labelKey ? t(group.labelKey) : undefined,
      shortcut: entry.jump ? `g ${entry.jump}` : undefined,
      href: entry.path,
      keywords: [entry.path, entry.moduleKey ?? ""].filter(Boolean),
    }))
  );
}

/** "New …" for what this user can create: a dataset, an entry per dataset, a record per model. */
export function createItems(
  input: {
    datasets: PaletteDataset[];
    models: PaletteModel[];
    isAdmin: boolean;
    datasetsOn: boolean;
  },
  t: Translate
): PaletteItem[] {
  const group = t("palette.groupCreate");
  const items: PaletteItem[] = [];
  if (input.datasetsOn) {
    items.push({ id: "new:dataset", label: t("palette.newDataset"), group, href: "/datasets/new" });
    for (const d of input.datasets) {
      items.push({
        id: `new:entry:${d.id}`,
        label: t("palette.newIn", { name: d.name }),
        group,
        href: `/datasets/${d.id}/entries/new`,
        keywords: [d.slug ?? "", "entry"].filter(Boolean),
      });
    }
  }
  for (const m of input.models) {
    items.push({
      id: `new:model:${m.kon}/${m.name}`,
      label: t("palette.newIn", { name: m.name }),
      group,
      description: m.kon,
      href: `${m.path}/new`,
      keywords: [m.plural, m.kon],
    });
  }
  if (input.isAdmin) {
    items.push({ id: "new:agent", label: t("palette.newAgent"), group, href: "/agents?new=1" });
  }
  return items;
}

export function recentItems(recent: RecentItem[], t: Translate): PaletteItem[] {
  return recent.map((r) => ({
    id: `recent:${r.path}`,
    label: r.label,
    group: t("palette.groupRecent"),
    description: r.section,
    href: r.path,
  }));
}

/** A record a search found, before it becomes an item. */
export interface FoundRecord {
  /** Where it lives: the dataset's or the model's name. */
  source: string;
  kind: "dataset" | "model";
  href: string;
  row: Record<string, unknown>;
  titleField?: string | null;
}

/**
 * Search results as items. `query` goes into the keywords so the palette's own filter
 * (which matches label and keywords) keeps a record the API matched on another field.
 */
export function recordItems(found: FoundRecord[], query: string, t: Translate): PaletteItem[] {
  return found
    .map((f) => ({ f, title: recordTitle(f.row, f.titleField) }))
    .filter(({ title }) => title !== "")
    .map(({ f, title }) => ({
      id: `record:${f.href}`,
      label: title,
      group: t("palette.groupRecords"),
      description: f.source,
      badge: t(f.kind === "dataset" ? "palette.badgeEntry" : "palette.badgeRecord"),
      href: f.href,
      keywords: [query],
    }));
}

/** Rows whose text contains every word of `query` (models have no text search of their own). */
export function matchRows<T extends Record<string, unknown>>(rows: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return rows.filter((row) => {
    const haystack = Object.values(row)
      .filter((v) => typeof v === "string" || typeof v === "number")
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** The key of a `g` + letter sequence, or null when `key` does not complete one. */
export function jumpFor(
  pending: boolean,
  key: string,
  targets: Map<string, NavEntry>
): NavEntry | null {
  if (!pending) return null;
  return targets.get(key.toLowerCase()) ?? null;
}

/** A key press is "typing" when it happens in a field: shortcuts stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']"
  );
}
