import { redirect } from "@sveltejs/kit";

// @ts-ignore — SvelteKit generated types
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
  throw redirect(308, "/g/kon-academy-lms");
};

/**
 * The destination was `/g/grimoire-academy-lms`, an id that does not exist.
 *
 * It is collateral damage from the grimoire → kon rename: the package ids were
 * changed and these redirectors kept the old name, so
 * they led to a 404. Since they are redirectors, the 404 showed up on a DIFFERENT route than
 * the one requested, which makes it hard to connect to the cause.
 *
 * `tests/unit/panel-links.test.ts` watches for this.
 */
