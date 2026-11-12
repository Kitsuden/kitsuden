/**
 * Where the Academy view leads: kon-academy-lms's grid views, each a list on the panel's
 * list template with a record page per row (`/g/kon-academy-lms/<view>/<id>`). The edit
 * buttons used to open `/academy/<kind>/<id>/edit`, a route the panel does not have.
 */
export type AcademyView = "grid-courses" | "grid-learning-paths" | "grid-groups";

export function academyHref(view: AcademyView, id?: string): string {
  const base = `/g/kon-academy-lms/${view}`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}
