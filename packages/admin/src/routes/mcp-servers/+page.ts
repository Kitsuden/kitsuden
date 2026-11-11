import { redirect } from "@sveltejs/kit";

import { movedRoute } from "$lib/nav";

// This route moved when the sidebar was regrouped (see MOVED_ROUTES in $lib/nav.ts); the
// old address still works and lands on the new page, query string kept.
export function load({ url }: { url: URL }) {
  redirect(307, movedRoute(url) ?? "/");
}
