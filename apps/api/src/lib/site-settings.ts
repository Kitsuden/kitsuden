/**
 * The site's public URL, read from the panel
 * ============================================================================
 *
 * General settings → Site URL is stored in `site_settings`, and until now
 * nobody read it: the kon context took the environment variable. This
 * module is the live read that kons receive as `ctx.site`.
 *
 * 30 s cache because every wiki URL needs it and it is a row that almost
 * never changes. Saving the settings invalidates it (`forgetSiteSettings`),
 * so a change in the panel shows up on the next request, not half a minute
 * later.
 *
 * It lives apart from module-loader so the settings route can invalidate it
 * without importing the kon loader (and without opening an import cycle).
 */

import { effectivePublicUrl } from "@kitsuden/shared";

import { db } from "../db";
import { siteSettings } from "../db/schema";

const TTL_MS = 30_000;

let cached: { value: string; expires: number } | null = null;

export async function sitePublicUrl(): Promise<string> {
  if (cached && cached.expires > Date.now()) return cached.value;

  let ofThePanel: string | null = null;
  try {
    const [settings] = await db
      .select({ siteUrl: siteSettings.siteUrl })
      .from(siteSettings)
      .limit(1);
    ofThePanel = settings?.siteUrl ?? null;
  } catch {
    // Without a database it keeps serving from the environment: generating a wiki
    // URL should not depend on the settings table responding.
  }

  const value = effectivePublicUrl(ofThePanel, process.env.SITE_URL);
  cached = { value, expires: Date.now() + TTL_MS };
  return value;
}

/** Called by whoever saves the site settings. */
export function forgetSiteSettings(): void {
  cached = null;
}
