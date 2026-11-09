/**
 * Per-request setup
 * ============================================================================
 *
 *   1. `locals.kitsuden`: the API client for this request, carrying the site
 *      key and the visitor IP (see `lib/kitsuden.ts`).
 *   2. If the API cannot answer (429, 5xx, down), the visitor gets a 503 with
 *      `Retry-After` instead of a 404 or a stack trace: "come back later" is
 *      the one answer that does not make a search engine forget the page.
 */
import { KITSUDEN_API_URL, KITSUDEN_SITE_KEY, KITSUDEN_TRUST_PROXY } from "astro:env/server";
import { defineMiddleware } from "astro:middleware";

import { t } from "./i18n";
import { visitorIp } from "./lib/client-ip";
import { ApiUnavailableError, createKitsuden } from "./lib/kitsuden";
import { site } from "./lib/site";
import { escapeHtml } from "./lib/text";

function clientIp(
  context: Parameters<Parameters<typeof defineMiddleware>[0]>[0]
): string | undefined {
  try {
    return visitorIp(
      context.clientAddress,
      context.request.headers.get("x-forwarded-for"),
      KITSUDEN_TRUST_PROXY
    );
  } catch {
    // Not available while prerendering
    return undefined;
  }
}

function unavailable(): Response {
  const title = escapeHtml(t(site.locale, "unavailable.title"));
  const body = escapeHtml(t(site.locale, "unavailable.body"));
  return new Response(
    `<!doctype html><html lang="${site.locale}"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${title}</h1><p>${body}</p></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "60",
        "cache-control": "no-store",
      },
    }
  );
}

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.kitsuden = createKitsuden({
    apiUrl: KITSUDEN_API_URL,
    siteKey: KITSUDEN_SITE_KEY,
    clientIp: clientIp(context),
  });

  try {
    return await next();
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      console.warn(`[starter] ${error.message}`);
      return unavailable();
    }
    throw error;
  }
});
