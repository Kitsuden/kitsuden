/**
 * The `data-inti-*` markup of a page-builder block
 * ============================================================================
 *
 * Inti's inline editor finds blocks and fields through attributes on the
 * rendered HTML (the same ones `@intijs/core/astro/BlockRenderer.astro`
 * writes). This site renders its blocks itself, in both modes, and adds the
 * attributes ONLY for a request that Inti recognises as an editor. For any
 * other visitor these helpers return nothing and Astro writes no attribute,
 * so the public HTML is the same with and without Inti.
 *
 *   data-inti-block           block type (marks the wrapper)
 *   data-inti-block-id        row uuid in block_contents
 *   data-inti-document-id     page uuid (the adapter writes by uuid)
 *   data-inti-content-type    "page"
 *   data-inti-block-label     native type, used by the composer palette
 *   data-inti-block-index     position in the page's visible block list
 *   data-inti-block-total     length of that list
 *   data-inti-field           the content key a text element shows
 *
 * The index is the position in the list returned by
 * `GET /api/page-builder/pages/:slug`, sorted by `sortOrder`: exactly the list
 * `@intijs/adapter-kitsuden` re-reads before every write. Nested blocks
 * (inside `grid`) are not marked: they have no row of their own.
 */

export type IntiAttributes = Record<string, string | undefined>;

/**
 * Always a NEW empty object, never a shared frozen one: Astro adds the scoped
 * `class` to the attributes spread on an element, and a frozen object makes
 * that throw in the middle of the stream (the page is cut short).
 */
const none = (): IntiAttributes => ({});

export interface MarkupContext {
  editable: boolean;
  documentId: string;
  total: number;
}

export function blockAttributes(
  ctx: MarkupContext | null | undefined,
  block: { id?: unknown; type?: unknown },
  index: number
): IntiAttributes {
  if (!ctx?.editable || typeof block.id !== "string" || typeof block.type !== "string")
    return none();
  return {
    "data-inti-block": block.type,
    "data-inti-block-id": block.id,
    "data-inti-document-id": ctx.documentId,
    "data-inti-content-type": "page",
    "data-inti-block-label": block.type,
    "data-inti-block-index": String(index),
    "data-inti-block-total": String(ctx.total),
  };
}

/** `data-inti-field="<key>"` for an editor, nothing for everyone else */
export function fieldAttributes(editable: boolean | undefined, key: string): IntiAttributes {
  return editable ? { "data-inti-field": key } : none();
}

/** The block data as JSON safe inside `<script>`, or `null` when not editing */
export function blockJson(editable: boolean | undefined, data: unknown): string | null {
  return editable ? JSON.stringify(data ?? {}).replace(/</g, "\\u003c") : null;
}
