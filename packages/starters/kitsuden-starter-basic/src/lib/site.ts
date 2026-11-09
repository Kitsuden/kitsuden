/** Site-wide settings, from the environment (see astro.config.mjs → env.schema) */
import { SITE_LOCALE, SITE_NAME } from "astro:env/server";

import { resolveLocale } from "../i18n";

export const site = {
  name: SITE_NAME,
  locale: resolveLocale(SITE_LOCALE),
};
