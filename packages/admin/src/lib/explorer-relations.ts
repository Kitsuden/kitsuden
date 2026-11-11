/**
 * Which table a foreign-key column points to.
 *
 * The explorer only has the column's name to go on (`department_id`, `managerId`), so the
 * table is a guess. The guess used to be one name (`departments`), asked for only when the
 * explorer knew a table called exactly that. A kon's tables carry the kon's prefix
 * (`directory_departments`), so inside a kon the guess never matched: the relation select
 * of the edit dialog opened empty and the table showed raw ids.
 *
 * Here the guess is a list of candidates, tried against the tables the explorer really
 * has. Both the table (display values, filters) and the form (the select's options) use it.
 */

/** Columns whose target cannot be derived from their name. */
export const FK_TABLE_MAP: Record<string, string> = {
  platform_id: "platforms",
  platformId: "platforms",
  tag_id: "tags",
  tagId: "tags",
  streamer_id: "streamers",
  streamerId: "streamers",
  collection_id: "collections",
  collectionId: "collections",
  user_id: "auth_users",
  userId: "auth_users",
  author_id: "auth_users",
  authorId: "auth_users",
  assigned_to_id: "auth_users",
  assignedToId: "auth_users",
  uploaded_by_id: "auth_users",
  uploadedById: "auth_users",
  created_by_id: "auth_users",
  createdById: "auth_users",
  contact_id: "contacts",
  contactId: "contacts",
  dataset_id: "datasets",
  datasetId: "datasets",
  thumbnail_id: "media",
  thumbnailId: "media",
  cover_art_id: "media",
  coverArtId: "media",
  featured_image_id: "media",
  featuredImageId: "media",
  avatar_id: "media",
  avatarId: "media",
  icon_id: "media",
  iconId: "media",
};

/** `departmentId` / `department_id` → `department`; `assignedToId` → `assigned_to`. */
export function relationBase(column: string): string {
  return column
    .replace(/_id$/, "")
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function plural(word: string): string {
  if (word.endsWith("s")) return word;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * Table names to try for `column`, best first: the fixed map, the plain plural, then the
 * same names behind the prefix of the table being edited (`directory_employees` →
 * `directory_`), which is how a kon names its tables.
 */
export function relatedTableCandidates(column: string, currentTable = ""): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (name && !out.includes(name)) out.push(name);
  };
  if (FK_TABLE_MAP[column]) add(FK_TABLE_MAP[column]);
  const base = relationBase(column);
  add(plural(base));
  add(base);
  const parts = currentTable.split("_").filter(Boolean);
  // Longest prefix first: `ocr_training_jobs` → `ocr_training_`, then `ocr_`.
  for (let n = parts.length - 1; n >= 1; n--) {
    const prefix = parts.slice(0, n).join("_");
    add(`${prefix}_${plural(base)}`);
    add(`${prefix}_${base}`);
  }
  return out;
}

/** The first candidate the explorer really has, or null: then nothing is requested. */
export function resolveRelatedTable(
  column: string,
  currentTable: string,
  known: ReadonlySet<string>
): string | null {
  return relatedTableCandidates(column, currentTable).find((name) => known.has(name)) ?? null;
}
