/**
 * Inti runtime WITH Inti (INTI=true): same exports as `../runtime.ts`
 * ============================================================================
 *
 * Asks Inti's own rule whether this request may see the editor:
 * development → yes; otherwise only when the plugin registered in
 * `./middleware.ts` identifies a Kitsuden admin/editor.
 */
import { resolveEditorSession } from "@intijs/core/server";

import type { EditorRequest } from "../runtime";

export type { EditorRequest };

export async function isEditor(astro: EditorRequest): Promise<boolean> {
  const decision = await resolveEditorSession({
    request: astro.request,
    cookies: astro.cookies,
    prerendered: astro.isPrerendered,
  });
  return decision.allowed;
}
