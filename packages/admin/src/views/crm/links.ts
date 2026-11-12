/**
 * Where the CRM dashboard leads. Contacts and companies are kon-crm's grid views: a list
 * on the panel's list template with a record page per row (`/g/kon-crm/<view>/<id>`, `/new`
 * for a new one). Deals are a board with no record page, so the dashboard edits a deal in a
 * sheet. It used to open `/crm/<kind>/<id>`, a route the panel does not have: every "Edit"
 * ended on a 404.
 */
export type CrmKind = "deals" | "contacts" | "companies";

/** The list of `kind`, a record of it (`id`), or the form for a new one (`"new"`). */
export function crmHref(kind: CrmKind, id?: string): string {
  const base = `/g/kon-crm/${kind}`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}
