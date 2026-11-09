/**
 * Tables the data explorer knows (GET /api/explorer/tables), requested
 * only once per page load. It avoids asking about relation options
 * from tables that only exist as a guess based on a column's name.
 */
const API_URL = import.meta.env.VITE_API_URL ?? "";

let pending: Promise<Set<string>> | null = null;

export function knownTables(): Promise<Set<string>> {
  pending ??= fetch(`${API_URL}/api/explorer/tables`, { credentials: "include" })
    .then((r) => (r.ok ? r.json() : { tables: [] }))
    .then((d: { tables?: Array<{ key: string }> }) => new Set((d.tables ?? []).map((t) => t.key)))
    .catch(() => {
      pending = null; // retry on the next open
      return new Set<string>();
    });
  return pending;
}
