/**
 * What every block component receives
 * ============================================================================
 *
 * A block component gets the block's `content` spread as props (the same
 * contract as Inti's BlockRenderer, so the components work in both modes)
 * plus `block`, which says where it sits on the page.
 *
 * Two vocabularies reach a page today: the page-builder palette
 * (`GET /api/page-builder/block-types`: `headline`, `primaryButton`…) and the
 * admin's block editor (`title`, `ctaLabel`…). Components accept both.
 */
export interface BlockContext {
  index: number;
  isFirst: boolean;
  /** The request comes from an Inti editor: write `data-inti-field` */
  editable: boolean;
}

export type BlockProps<T = Record<string, unknown>> = T & { block?: BlockContext };

/** First key of `keys` that holds a non-empty string in `data` */
export function pick(
  data: Record<string, unknown>,
  ...keys: string[]
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return { key, value };
  }
  return null;
}

export const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
