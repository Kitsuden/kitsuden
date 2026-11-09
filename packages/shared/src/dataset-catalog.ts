import { sql } from "drizzle-orm";

import { resolveFieldType, schemaFields } from "./field-types";
import { checkReadAccess, type PolicyJson, type RLSUser } from "./rls-builder";

/**
 * Reading a CMS dataset as a kon's catalog
 * ============================================================================
 *
 * ── WHY IT IS HERE AND NOT IN A KON ────────────────────────────────────────
 *
 * `kon-tierlist` was the first to read `data_sets`/`data_entries` to build
 * its catalog, and it did it well: respecting `checkReadAccess` and taking the
 * image field from what the dataset DECLARES instead of guessing by name.
 *
 * As soon as a second kon needed the same —the card simulator and the
 * character builder— copying those fifty lines would have created three
 * readers that drift apart. And the one that silently drifts is the ACCESS
 * one: it is enough for one copy to forget `checkReadAccess` for that kon
 * to become a back door into another kon's private datasets. It is not
 * hypothetical, it is the default failure mode of copy-pasting a read function.
 *
 * That is why it lives in `@kitsuden/shared`, next to the access check it
 * forces you to use.
 *
 * ── NOTHING IS GUESSED ─────────────────────────────────────────────────────
 *
 * Fields come from the `schema` the dataset declares, never from heuristics
 * on the column name. "If it is called `name` it will be the label" is where
 * catalogs with the wrong label come from, and it fails as soon as
 * someone writes their dataset in another language.
 */

/** A field as declared by the dataset's `schema`. */
export interface DatasetField {
  name?: string;
  key?: string;
  type?: string;
  label?: string;
}

/** A row of the dataset. `title` is `NOT NULL` in the model: it is always there. */
export interface DatasetEntry {
  id: string;
  title: string;
  data: Record<string, unknown>;
}

export interface DatasetCatalog {
  dataset: { id: string; name: string };
  fields: DatasetField[];
  entries: DatasetEntry[];
  /**
   * Field declared as an image, or `null`. It goes in the responses: if the
   * whole catalog comes out without a photo, this says why without having to
   * open the code.
   */
  imageField: string | null;
  /** The first field declared with that type, or `null`. */
  fieldOfType(type: string): string | null;
}

/**
 * Row cap.
 *
 * A dataset does not have to be small —the One Piece dump is 2,876
 * cards— and an unbounded query is the one that takes the process down the day
 * someone uploads a catalog of a hundred thousand rows. The cap is declared here,
 * can be raised per call, and routes say in their response whether they hit it.
 */
export const DATASET_MAX_ROWS = 5000;

/** The minimum asked of the database: run SQL. */
export interface DatasetReader {
  execute(query: unknown): Promise<unknown>;
}

/** Drizzle's `execute` returns rows or `{ rows }` depending on the driver. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = result as { rows?: unknown };
  return Array.isArray(wrapped?.rows) ? (wrapped.rows as T[]) : [];
}

/**
 * A CMS dataset, with its access control already applied.
 *
 * Returns `null` both if the dataset does not exist and if the user cannot
 * read it: from the outside they are the same result on purpose, because
 * telling them apart turns the route into an oracle that confirms which datasets exist.
 */
export async function readDatasetCatalog(
  db: DatasetReader,
  datasetId: string,
  user: RLSUser,
  options: { limit?: number } = {}
): Promise<DatasetCatalog | null> {
  const limit = Math.min(options.limit ?? DATASET_MAX_ROWS, DATASET_MAX_ROWS);

  const [dataset] = rowsOf<{
    id: string;
    name: string;
    schema: unknown;
    policy_json: unknown;
  }>(
    await db.execute(
      sql`SELECT id, name, schema, policy_json FROM data_sets WHERE id = ${datasetId} LIMIT 1`
    )
  );

  if (!dataset) return null;
  if (!checkReadAccess((dataset.policy_json ?? null) as PolicyJson | null, user)) return null;

  // Either form of `schema`, with the key and type resolved
  // the same way validation resolves them (`key|fieldName|name`, `type|fieldType`)
  const fields: DatasetField[] = schemaFields(dataset.schema).map((f) => ({
    ...(f as DatasetField),
    key: (f.key ?? f.fieldName ?? f.name) as string | undefined,
    type: (f.type ?? f.fieldType) as string | undefined,
  }));

  const fieldOfType = (type: string): string | null => {
    const hit = fields.find((f) => resolveFieldType(f.type) === type);
    return hit?.key ?? hit?.name ?? null;
  };

  const entries = rowsOf<{ id: string; title: string; data: Record<string, unknown> | null }>(
    await db.execute(
      sql`SELECT id, title, data FROM data_entries
          WHERE data_set_id = ${datasetId}
          ORDER BY sort_order NULLS LAST, title
          LIMIT ${limit}`
    )
  ).map((e) => ({ id: e.id, title: e.title, data: e.data ?? {} }));

  return {
    dataset: { id: dataset.id, name: dataset.name },
    fields,
    entries,
    // `image` references a media item by id and `url` is already an address. `image`
    // is preferred because it is what a catalog usually declares.
    imageField: fieldOfType("image") ?? fieldOfType("url"),
    fieldOfType,
  };
}

/**
 * A usable image URL, or `null`.
 *
 * Only what is ALREADY an address is accepted. An `image` field stores the id of
 * a media item, and putting a uuid in a `src` gives a broken image — which reads as
 * "this row has no photo" and not as "the id needs resolving".
 */
export function datasetImageUrl(value: unknown): string | null {
  return typeof value === "string" && /^(https?:|\/)/.test(value) ? value : null;
}

/** A number from the dataset, or `undefined`. Datasets often store text. */
export function datasetNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
