/**
 * The block contract's key names, and the bridge from the 0.8 (Spanish) ones
 * ============================================================================
 *
 * Block data (`block_contents.content`, `block_templates.content`, the `data` of every block in
 * `blog_posts.blocks` and `games.blocks`) and the editorial layer kon-games keeps over a game's
 * blocks (`games.blocks[].editorial`) are stored JSON that travels to the admin panel, to Inti
 * (`@intijs/adapter-kitsuden`) and to the sites that render blocks. Up to 0.8 their keys were
 * Spanish (`titulo`, `descripcion`, `campos`, `oculto`, `orden`…); from 0.9 they are English.
 *
 * The tables below are the WHOLE rename, and three places follow them:
 *
 *   - the migrations that rewrite stored JSON (`packages/core/blocks/migrations/0010_english_block_keys.sql`,
 *     kon-games `0003_english_block_keys.sql`, kon-blog `0010_english_block_keys.sql`), which repeat
 *     these tables in SQL. `tests/unit/block-keys.test.ts` runs them against these functions;
 *   - the READ side (`readBlockData`, `readEditorial`): data a 0.8 writer left behind still renders.
 *     Remove in 0.10;
 *   - the WRITE side (`findSpanishBlockKeys`, `findSpanishEditorialKeys`): a write that still uses
 *     a 0.8 name is a 422 whose hint names the English key, never a silent save of a key nobody
 *     reads.
 *
 * The rule for one key, everywhere: if only the Spanish key is there it moves to the English one
 * (with its value translated when the value is a Spanish word from a closed list); if both are
 * there the English value wins and the Spanish one is dropped; anything else is left as it is.
 */

/** Old (0.8) name → English name. */
export type KeyRenames = Readonly<Record<string, string>>;

/** Keys that every block type may carry at the top of its data. */
export const COMMON_BLOCK_KEYS: KeyRenames = {
  titulo: "title",
  subtitulo: "subtitle",
  descripcion: "description",
  nota: "note",
};

/** Top-level keys that only some block types carry. */
export const BLOCK_KEYS_BY_TYPE: Readonly<Record<string, KeyRenames>> = {
  comments: { orden: "order" },
  dex: {
    segmento: "segment",
    campos: "fields",
    facetas: "facets",
    habilidades: "skills",
    rasgo: "trait",
    evolucion: "evolution",
    noticias: "news",
  },
  affinity: { campos: "fields", etiquetas: "labels" },
  "event-search": { campos: "fields" },
  "race-planner": { campos: "fields" },
  "card-browser": { juegoDeCartas: "cardGame", facetas: "facets" },
  "deck-builder": { juegoDeCartas: "cardGame" },
  "deck-showcase": { juegoDeCartas: "cardGame" },
  deck: { juego: "game", arquetipo: "archetype", mazo: "deck", vista: "view" },
};

/** Inside `fields`: which column of the dataset row is each thing. */
export const FIELD_KEYS: KeyRenames = {
  clave: "key",
  nombre: "name",
  imagen: "image",
  icono: "icon",
  numero: "number",
  grupos: "groups",
  opciones: "options",
  descripcion: "description",
  fuente: "source",
};

/** Each element of `facets`, `chips` and `skills.groups`. */
export const ITEM_KEYS: KeyRenames = { campo: "field", etiqueta: "label", herramienta: "tool" };

/** A linked dataset (`skills`, `trait`, `evolution`, `news` of a `dex` block). */
export const LINKED_DATASET_KEYS: KeyRenames = {
  campo: "field",
  clave: "key",
  nombre: "name",
  imagen: "image",
  icono: "icon",
  grupos: "groups",
};

/** `labels` of an `affinity` block: what each piece of the inheritance tree is called. */
export const LABEL_KEYS: KeyRenames = { progenitor: "parent" };

/** Values that were Spanish words from a closed list, by block type and (English) key. */
export const BLOCK_VALUES_BY_TYPE: Readonly<Record<string, Readonly<Record<string, KeyRenames>>>> =
  {
    comments: { order: { mejores: "best", nuevos: "newest", antiguos: "oldest" } },
    deck: { view: { resumen: "summary", lista: "list" } },
  };

/** The editorial layer kon-games keeps over each game block. */
export const EDITORIAL_KEYS: KeyRenames = {
  titulo: "title",
  descripcion: "description",
  oculto: "hidden",
  orden: "order",
};

/** Which nested containers of a type's data hold renamed keys too. */
const NESTED_BY_TYPE: Readonly<
  Record<string, ReadonlyArray<{ key: string; renames: KeyRenames; list?: boolean }>>
> = {
  dex: [
    { key: "fields", renames: FIELD_KEYS },
    { key: "facets", renames: ITEM_KEYS, list: true },
    { key: "chips", renames: ITEM_KEYS, list: true },
    { key: "skills", renames: LINKED_DATASET_KEYS },
    { key: "trait", renames: LINKED_DATASET_KEYS },
    { key: "evolution", renames: LINKED_DATASET_KEYS },
    { key: "news", renames: LINKED_DATASET_KEYS },
  ],
  affinity: [
    { key: "fields", renames: FIELD_KEYS },
    { key: "labels", renames: LABEL_KEYS },
  ],
  "event-search": [{ key: "fields", renames: FIELD_KEYS }],
  "race-planner": [{ key: "fields", renames: FIELD_KEYS }],
  "card-browser": [{ key: "facets", renames: ITEM_KEYS, list: true }],
};

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * `obj` with each old key moved to its English name; the English value wins when both are there.
 * Returns the same object when nothing changes (cheap on the read path, which is almost always
 * English already).
 */
function renameKeys(
  obj: Json,
  renames: KeyRenames,
  values?: Readonly<Record<string, KeyRenames>>
): Json {
  let out: Json | null = null;
  for (const [old, english] of Object.entries(renames)) {
    if (!own(obj, old)) continue;
    out ??= { ...obj };
    if (!own(out, english)) {
      const value = out[old];
      const map = values?.[english];
      out[english] = typeof value === "string" && map && own(map, value) ? map[value] : value;
    }
    delete out[old];
  }
  return out ?? obj;
}

/**
 * Block data with the English keys, accepting the 0.8 (Spanish) ones.
 *
 * Remove in 0.10: by then every stored block has gone through the 0.9 migrations, and a writer
 * that still sends Spanish keys has been getting a 422 for a whole version.
 *
 * Anything that is not a plain object comes back untouched, and an object that has no old key
 * comes back as the SAME object.
 */
// Remove in 0.10
export function readBlockData<T = unknown>(type: unknown, data: T): T {
  if (!isPlainObject(data)) return data;
  const t = typeof type === "string" ? type : "";
  let out = renameKeys(data, COMMON_BLOCK_KEYS);
  out = renameKeys(out, BLOCK_KEYS_BY_TYPE[t] ?? {}, BLOCK_VALUES_BY_TYPE[t]);
  for (const nested of NESTED_BY_TYPE[t] ?? []) {
    const inner = out[nested.key];
    const next = nested.list
      ? renameInList(inner, nested.renames)
      : renameInObject(inner, nested.renames);
    if (next === inner) continue;
    // `out` is still the caller's object only if no top-level key moved: copy before writing.
    if (out === data) out = { ...out };
    out[nested.key] = next;
  }
  return out as T;
}

/** Each object of a list renamed; the same list when none changed. */
function renameInList(list: unknown, renames: KeyRenames): unknown {
  if (!Array.isArray(list)) return list;
  const items = list.map((item) => (isPlainObject(item) ? renameKeys(item, renames) : item));
  return items.some((item, i) => item !== list[i]) ? items : list;
}

/** An object renamed; a linked dataset also gets its `groups` list renamed like the facets. */
function renameInObject(obj: unknown, renames: KeyRenames): unknown {
  if (!isPlainObject(obj)) return obj;
  const out = renameKeys(obj, renames);
  if (renames !== LINKED_DATASET_KEYS) return out;
  const groups = renameInList(out.groups, ITEM_KEYS);
  return groups === out.groups ? out : { ...out, groups };
}

/**
 * The editorial layer of a game block with the English keys, accepting the 0.8 ones
 * (`titulo`, `descripcion`, `oculto`, `orden`). Same rule as `readBlockData`.
 */
// Remove in 0.10
export function readEditorial<T = unknown>(layer: T): T {
  return (isPlainObject(layer) ? renameKeys(layer, EDITORIAL_KEYS) : layer) as T;
}

/** A 0.8 key (or value) found in a write. */
export interface SpanishKey {
  /** Where: `titulo`, `fields.nombre`, `facets[0].campo`, `order` (for a value). */
  path: string;
  /** What to send instead. */
  use: string;
}

function collect(obj: Json, renames: KeyRenames, prefix: string, found: SpanishKey[]) {
  for (const [old, english] of Object.entries(renames)) {
    if (own(obj, old)) found.push({ path: prefix + old, use: prefix + english });
  }
}

/**
 * Every 0.8 key in a block's data, nested ones included, and every Spanish value from a closed
 * list (`order: "mejores"`). Empty = the data speaks the 0.9 contract.
 */
export function findSpanishBlockKeys(type: unknown, data: unknown): SpanishKey[] {
  const found: SpanishKey[] = [];
  if (!isPlainObject(data)) return found;
  const t = typeof type === "string" ? type : "";
  collect(data, COMMON_BLOCK_KEYS, "", found);
  collect(data, BLOCK_KEYS_BY_TYPE[t] ?? {}, "", found);
  for (const nested of NESTED_BY_TYPE[t] ?? []) {
    // The nested keys are looked for under the English container AND under the old one, so a
    // write gets every complaint at once instead of one per round trip.
    const oldName = Object.entries(BLOCK_KEYS_BY_TYPE[t] ?? {}).find(
      ([, e]) => e === nested.key
    )?.[0];
    for (const name of [nested.key, oldName]) {
      if (!name) continue;
      const inner = data[name];
      if (nested.list && Array.isArray(inner)) {
        inner.forEach((item, i) => {
          if (isPlainObject(item)) collect(item, nested.renames, `${name}[${i}].`, found);
        });
      } else if (!nested.list && isPlainObject(inner)) {
        collect(inner, nested.renames, `${name}.`, found);
        if (nested.renames === LINKED_DATASET_KEYS) {
          for (const groupsName of ["groups", "grupos"]) {
            const groups = inner[groupsName];
            if (!Array.isArray(groups)) continue;
            groups.forEach((g, i) => {
              if (isPlainObject(g)) collect(g, ITEM_KEYS, `${name}.${groupsName}[${i}].`, found);
            });
          }
        }
      }
    }
  }
  for (const [key, map] of Object.entries(BLOCK_VALUES_BY_TYPE[t] ?? {})) {
    const v = data[key];
    if (typeof v === "string" && own(map, v)) {
      found.push({ path: `${key}: "${v}"`, use: `${key}: "${map[v]}"` });
    }
  }
  return found;
}

/** Every 0.8 key in an editorial layer (or a body for it). */
export function findSpanishEditorialKeys(layer: unknown): SpanishKey[] {
  const found: SpanishKey[] = [];
  if (isPlainObject(layer)) collect(layer, EDITORIAL_KEYS, "", found);
  return found;
}

/**
 * The body of the 422 for a write that still uses 0.8 names: `error` says what is wrong, `hint`
 * names the English key(s), `renamed` lists them for a client that wants to fix them itself.
 */
export function spanishKeysError(
  found: SpanishKey[],
  where = "block data"
): { error: string; hint: string; renamed: SpanishKey[] } {
  const list = found.map((k) => `«${k.path}» → «${k.use}»`).join(", ");
  return {
    error: `The ${where} uses key names from Kitsuden 0.8, which 0.9 no longer accepts: ${found
      .map((k) => `«${k.path}»`)
      .join(", ")}`,
    hint: `Use the English names: ${list}.`,
    renamed: found,
  };
}
