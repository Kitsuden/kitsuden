/**
 * One kon's admin configuration out of `GET /api/admin/registry/:konId`.
 *
 * The API answers `{ success, contract, kon }` (routes/admin-registry.ts). The loader read
 * `data.grimoire`, the key's name before the grimoire → kon rename, so its fallback gave
 * `null` for every kon. `grimoire` is still accepted, for an API older than the rename.
 */
export function registryEntry<T>(data: unknown): T | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { success?: boolean; kon?: T | null; grimoire?: T | null };
  if (d.success === false) return null;
  return d.kon ?? d.grimoire ?? null;
}
