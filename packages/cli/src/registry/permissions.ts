/**
 * What an install or an update asks for — the permission diff
 * ============================================================================
 *
 * Same idea as the capability diff of code promotion (docs/agents/promotion.md
 * → "Declared capabilities"): compare what the new version DECLARES with what
 * the installed one declared, and make the human say yes to anything wider.
 *
 *   scopesAdded      scopes not covered by the old list (wildcards count:
 *                    `datasets:*:read` covers `datasets:clients:read`)
 *   denialsRemoved   `!deny` entries the new version drops (that widens too)
 *   hostsAdded       outbound hosts not covered (`*.a.com` covers `b.a.com`)
 *   sensitiveAdded   new sensitive operations
 *   tablesAdded, migrationsAdded, licenseChanged, keyChanged — shown, and the
 *   last two also require confirmation.
 */

import type { NormalizedManifest, DeclaredPermissions } from "./manifest.js";

export interface PermissionsDiff {
  id: string;
  from: string | null;
  until: string;
  next: boolean;
  scopesAdded: string[];
  denialsRemoved: string[];
  hostsAdded: string[];
  sensitiveAdded: string[];
  tablesAdded: string[];
  migrationsAdded: string[];
  licenseChanged: { from: string | null; to: string | null } | null;
  keyChanged: { from: string; to: string } | null;
}

function pattern(scope: string): RegExp {
  return new RegExp(
    "^" +
      scope
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^:]*") +
      "$"
  );
}

/** Does one of `list` cover `scope`? `*` matches within one segment; a trailing `:*` or bare `*` matches the rest. */
export function coveredScope(scope: string, list: string[]): boolean {
  return list.some((s) => {
    if (s.startsWith("!")) return false;
    if (s === "*" || s === "admin") return true;
    if (s === scope) return true;
    if (s.endsWith(":*") && scope.startsWith(s.slice(0, -1))) return true;
    return pattern(s).test(scope);
  });
}

export function coveredHost(host: string, list: string[]): boolean {
  return list.some(
    (h) =>
      h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)) && host.length > h.length - 1)
  );
}

const empty: DeclaredPermissions = { scopes: [], hosts: [], sensitive: [] };

export function permissionsDiff(
  before: { manifest: NormalizedManifest | null; keyId?: string | null } | null,
  after: { manifest: NormalizedManifest; keyId?: string | null }
): PermissionsDiff {
  const a = before?.manifest?.permissions ?? empty;
  const d = after.manifest.permissions ?? empty;
  const granted = a.scopes.filter((s) => !s.startsWith("!"));
  const negatedBefore = a.scopes.filter((s) => s.startsWith("!"));
  const negatedAfter = new Set(d.scopes.filter((s) => s.startsWith("!")));
  const licA = before?.manifest?.license ?? null;
  const licD = after.manifest.license ?? null;
  return {
    id: after.manifest.id,
    from: before?.manifest?.version ?? null,
    until: after.manifest.version,
    next: !before?.manifest,
    scopesAdded: d.scopes.filter((s) => !s.startsWith("!") && !coveredScope(s, granted)),
    denialsRemoved: negatedBefore.filter((s) => !negatedAfter.has(s)),
    hostsAdded: d.hosts.filter((h) => !coveredHost(h, a.hosts)),
    sensitiveAdded: d.sensitive.filter((s) => !a.sensitive.includes(s)),
    tablesAdded: after.manifest.tables.filter((t) => !(before?.manifest?.tables ?? []).includes(t)),
    migrationsAdded: after.manifest.migrations.filter(
      (m) => !(before?.manifest?.migrations ?? []).includes(m)
    ),
    licenseChanged: before?.manifest && licA !== licD ? { from: licA, to: licD } : null,
    keyChanged:
      before?.keyId && after.keyId && before.keyId !== after.keyId
        ? { from: before.keyId, to: after.keyId }
        : null,
  };
}

/** Wider than before: needs an explicit yes (on update, more than --yes). */
export function wide(d: PermissionsDiff): boolean {
  return (
    d.scopesAdded.length > 0 ||
    d.denialsRemoved.length > 0 ||
    d.hostsAdded.length > 0 ||
    d.sensitiveAdded.length > 0 ||
    d.keyChanged !== null
  );
}

export function diffText(d: PermissionsDiff, m: NormalizedManifest): string[] {
  const l: string[] = [];
  const title = d.next ? `${d.id}@${d.until} (new)` : `${d.id} ${d.from} → ${d.until}`;
  l.push(title);
  l.push(
    `    license     ${m.license ?? "(none)"}${d.licenseChanged ? `  (was ${d.licenseChanged.from ?? "none"})` : ""}`
  );
  if (m.author) l.push(`    author      ${m.author.name}`);
  if (m.repository) l.push(`    repository  ${m.repository.url}`);
  const p = m.permissions ?? empty;
  const mark = (x: string, newOnes: string[]) => (newOnes.includes(x) ? `+ ${x}` : `  ${x}`);
  l.push(
    `    scopes      ${p.scopes.length ? p.scopes.map((s) => mark(s, d.scopesAdded)).join(", ") : "(none)"}`
  );
  if (d.denialsRemoved.length) l.push(`    denials removed: ${d.denialsRemoved.join(", ")}`);
  l.push(
    `    hosts       ${p.hosts.length ? p.hosts.map((h) => mark(h, d.hostsAdded)).join(", ") : "(none: no outbound network)"}`
  );
  l.push(
    `    sensitive   ${p.sensitive.length ? p.sensitive.map((s) => mark(s, d.sensitiveAdded)).join(", ") : "(none)"}`
  );
  l.push(
    `    tables      ${m.tables.length ? m.tables.map((t) => mark(t, d.tablesAdded)).join(", ") : "(none)"}`
  );
  l.push(
    `    migrations  ${m.migrations.length ? m.migrations.map((x) => mark(x, d.migrationsAdded)).join(", ") : "(none)"}`
  );
  if (d.keyChanged) l.push(`    ! signing key changed: ${d.keyChanged.from} → ${d.keyChanged.to}`);
  return l;
}
