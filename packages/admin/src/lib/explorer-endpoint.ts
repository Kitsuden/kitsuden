/**
 * Where the data explorer lists a table.
 *
 * A kon that declares `admin.apiBase` promises that `<apiBase>/<resource>` lists each of
 * its tables. The table of a kon carries the kon's name as a prefix (`directory_employees`,
 * `ocr_documents`) and the route does not: kon-directory serves `/api/directory/employees`,
 * kon-vekstudio `/api/ocr/documents`. The explorer appended the table as it was and asked
 * for `/api/directory/directory_employees`, which nobody serves: every tab of the kon was a
 * 404.
 *
 * So the prefix that repeats the last segment of the base is dropped, and `_` becomes `-`
 * as in the kons' routes. A table without that prefix is used as it is.
 */
export function resourceForTable(base: string, table: string): string {
  const namespace = base.replace(/\/+$/, "").split("/").pop() ?? "";
  const prefix = `${namespace.replace(/-/g, "_")}_`;
  const name = namespace && table.startsWith(prefix) ? table.slice(prefix.length) : table;
  return name.replace(/_/g, "-");
}

/** True for a base such as `/api/directory`: two segments, the table still to be added. */
export function isApiBase(endpoint: string): boolean {
  return endpoint.replace(/^\//, "").replace(/\/+$/, "").split("/").length <= 2;
}

/**
 * The endpoint for `table`:
 *   no endpoint              → `/api/explorer/<table>`
 *   `/api/explorer/games`    → as it is (three segments or more: already complete)
 *   `/api/directory`         → `/api/directory/<resource>` (see `resourceForTable`)
 */
export function explorerEndpoint(endpoint: string | undefined, table: string): string {
  if (!endpoint) return `/api/explorer/${table}`;
  if (!isApiBase(endpoint)) return endpoint;
  return `${endpoint.replace(/\/+$/, "")}/${resourceForTable(endpoint, table)}`;
}
