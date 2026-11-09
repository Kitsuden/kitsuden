import { redirect } from "@sveltejs/kit";

// @ts-ignore — SvelteKit generated types
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
  throw redirect(308, "/g/kon-booking");
};
