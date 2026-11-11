import { redirect } from "@sveltejs/kit";

import { movedRoute } from "$lib/nav";

// SvelteKit SPA Mode - No SSR
export const ssr = false;
export const prerender = false;

// A route that moved (see MOVED_ROUTES in $lib/nav.ts) is replaced by its new address
// before anything renders: dynamic ones such as /g/kon-datasets are caught here.
export function load({ url }: { url: URL }) {
  const to = movedRoute(url);
  if (to) redirect(307, to);
}
