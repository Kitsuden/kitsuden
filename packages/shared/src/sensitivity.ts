/**
 * Field sensitivity: which values must not leave for a third party
 * ============================================================================
 *
 * A dataset field or a kon column can be marked:
 *
 *   dataset field:  { "key": "email", "type": "text", "sensitivity": "customer" }
 *   kon manifest:   "sensitivity": { "crm_contacts": { "email": "customer", "notes": "personal" } }
 *
 * `customer` is data about the business's customers; `personal` is any other
 * personal data. Both are treated the same on the way out (the API refuses or
 * redacts them for hosts not allowed for customer data); the level is kept so
 * the audit says which kind it was. Unmarked fields carry no restriction.
 *
 * Marking does NOT change who may read a field: that is still scopes and RLS.
 * It limits where an execution that read it may send it (docs/agents/egress.md).
 */

export const SENSITIVITY_LEVELS = ["customer", "personal"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

export function isSensitivity(v: unknown): v is Sensitivity {
  return typeof v === "string" && (SENSITIVITY_LEVELS as readonly string[]).includes(v);
}

/** The key a dataset field is stored under in `data` (several historical shapes). */
function fieldKey(f: Record<string, unknown>): string | null {
  for (const k of ["key", "name", "fieldName"]) {
    const v = f[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function fieldList(schema: unknown): Record<string, unknown>[] {
  const list = Array.isArray(schema)
    ? schema
    : schema && typeof schema === "object" && Array.isArray((schema as { fields?: unknown }).fields)
      ? (schema as { fields: unknown[] }).fields
      : [];
  return list.filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object");
}

/**
 * The marked fields of a dataset schema (either shape of `data_sets.schema`),
 * repeater subfields included: `{ key → level }`.
 */
export function markedDatasetFields(schema: unknown): Record<string, Sensitivity> {
  const out: Record<string, Sensitivity> = {};
  for (const f of fieldList(schema)) {
    const key = fieldKey(f);
    if (key && isSensitivity(f.sensitivity)) out[key] = f.sensitivity;
    for (const sub of Array.isArray(f.subFields) ? f.subFields : []) {
      if (!sub || typeof sub !== "object") continue;
      const subKey = fieldKey(sub as Record<string, unknown>);
      const level = (sub as Record<string, unknown>).sensitivity;
      if (subKey && isSensitivity(level)) out[subKey] = level;
    }
  }
  return out;
}

/**
 * Fields whose mark a schema change removes or weakens (`customer` → `personal`
 * counts as kept: both are protected the same way). Used to stop an agent from
 * unmarking a field it then wants to send out.
 */
export function droppedSensitivity(before: unknown, after: unknown): string[] {
  const was = markedDatasetFields(before);
  const now = markedDatasetFields(after);
  return Object.keys(was).filter((k) => !now[k]);
}

/**
 * The `sensitivity` block of a kon manifest, validated:
 * `{ table → { column → level } }`. Anything malformed is ignored.
 */
export function konSensitivity(manifest: unknown): Record<string, Record<string, Sensitivity>> {
  const raw = (manifest as { sensitivity?: unknown } | null)?.sensitivity;
  const out: Record<string, Record<string, Sensitivity>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [table, columns] of Object.entries(raw as Record<string, unknown>)) {
    if (!columns || typeof columns !== "object" || Array.isArray(columns)) continue;
    const cols: Record<string, Sensitivity> = {};
    for (const [column, level] of Object.entries(columns as Record<string, unknown>)) {
      if (column.trim() && isSensitivity(level)) cols[column.trim()] = level;
    }
    if (Object.keys(cols).length) out[table] = cols;
  }
  return out;
}
