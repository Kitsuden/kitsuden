/**
 * Inti runtime: the version used WITHOUT Inti (the default)
 * ============================================================================
 *
 * Nothing here imports `@intijs/*`. With `INTI=true`, astro.config.mjs
 * resolves every import of this file to `./live/runtime.ts`, which has the
 * same exports and asks Inti whether the request comes from an editor.
 */

export interface EditorRequest {
  request: Request;
  cookies: unknown;
  isPrerendered?: boolean;
}

/** Without Inti nobody is an editor: pages render with no editing markup */
export async function isEditor(_astro: EditorRequest): Promise<boolean> {
  return false;
}
