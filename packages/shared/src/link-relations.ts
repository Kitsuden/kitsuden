/**
 * Link relations: the common vocabulary (docs/kons/links.md)
 * ============================================================================
 *
 * `kitsuden_links.relation` is free text, and it stays free: a kon may invent
 * `invited_by` tomorrow without asking anyone. But two kons that mean the same
 * thing must write the same word, or the order a shop linked with `buyer` is
 * invisible to the CRM that reads `ordered_by`.
 *
 * These are the relations more than one kon is expected to share. Each says
 * which end is which, because "A ordered_by B" read backwards is nonsense and
 * nothing in the table would complain.
 *
 * `symmetric` relations have no direction. The engine stores them with the two
 * ends in a canonical order, so writing A–B and then B–A gives ONE row.
 */

export interface LinkRelationSpec {
  /** No direction: `same_person(A, B)` is `same_person(B, A)`. */
  symmetric: boolean;
  /** What the link states, as a sentence with `from` and `to`. */
  meaning: string;
  /** What `from` usually is. */
  from: string;
  /** What `to` usually is. */
  to: string;
}

export const LINK_RELATIONS = {
  related: {
    symmetric: true,
    meaning: "`from` and `to` have something to do with each other; nothing more is claimed.",
    from: "anything",
    to: "anything",
  },
  same_person: {
    symmetric: true,
    meaning: "`from` and `to` are records of the same human being in two kons.",
    from: "a person record (a CRM contact, a newsletter member, a player)",
    to: "another person record",
  },
  ordered_by: {
    symmetric: false,
    meaning: "the order `from` was placed by the person `to`.",
    from: "an order, a booking, a registration",
    to: "a person record",
  },
  paid_by: {
    symmetric: false,
    meaning: "the payment `from` was made by the person or organisation `to`.",
    from: "a payment, a subscription, an invoice",
    to: "a person or company record",
  },
  about: {
    symmetric: false,
    meaning: "the item `from` concerns the record `to`.",
    from: "a message, a meeting, a note, a document, a task",
    to: "the contact, deal, order or project it is about",
  },
} as const satisfies Record<string, LinkRelationSpec>;

export type CommonLinkRelation = keyof typeof LINK_RELATIONS;

/** Relations the engine stores in canonical order. Unknown relations are directed. */
export function isSymmetricRelation(relation: string): boolean {
  const spec = (LINK_RELATIONS as Record<string, LinkRelationSpec>)[relation];
  return spec?.symmetric === true;
}

/** `related`, `same_person`: letters, digits and `_`, at most 64 characters. */
export const LINK_RELATION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function isLinkRelationName(relation: unknown): relation is string {
  return typeof relation === "string" && LINK_RELATION_NAME.test(relation);
}

/**
 * The two ends of a symmetric link in the order they are stored: by type, then
 * by id. Deterministic, so both writers land on the same row.
 */
export function canonicalEnds<T extends { type: string; id: string }>(a: T, b: T): [T, T] {
  if (a.type < b.type) return [a, b];
  if (a.type > b.type) return [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}
