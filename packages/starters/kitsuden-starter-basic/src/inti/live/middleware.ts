/**
 * Inti's door (INTI=true only; added by astro.config.mjs with `order: "pre"`)
 * ============================================================================
 *
 *   1. Registers, once per process, the plugin that recognises Kitsuden
 *      editors (`./editor-session.ts`). It is registered here and not in the
 *      actions module because Astro loads that module only on the first
 *      action, and without the plugin nobody could open the editor to send one.
 *   2. Completes Inti's write adapter configuration, read from `process.env`
 *      at runtime: adapter `kitsuden` at `KITSUDEN_API_URL`. The agent key
 *      (`INTI_KITSUDEN_TOKEN`) is never completed: without it nothing is written.
 *   3. An editor's response is marked `private, no-store`: it carries the
 *      editing markup, and a shared cache must never serve it to anyone else.
 */
import { registerIntiPlugin } from "@intijs/core/plugins";
import { KITSUDEN_API_URL } from "astro:env/server";
import { defineMiddleware } from "astro:middleware";

import { kitsudenEditorPlugin, perRequest, resolveEditor } from "./editor-session";

process.env.INTI_ADAPTER ||= "kitsuden";
process.env.INTI_KITSUDEN_ENDPOINT ||= KITSUDEN_API_URL;

const editorOf = perRequest((cookie) => resolveEditor(cookie, { api: KITSUDEN_API_URL }));
registerIntiPlugin(kitsudenEditorPlugin(editorOf) as Parameters<typeof registerIntiPlugin>[0]);

export const onRequest = defineMiddleware(async (context, next) => {
  const editor = await editorOf(context.request);
  const response = await next();
  if (!editor) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  if (!/\bcookie\b/i.test(headers.get("vary") ?? "")) headers.append("vary", "Cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
