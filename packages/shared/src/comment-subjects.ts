/**
 * What can be commented on, declared in ONE place
 * ============================================================================
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 *
 * `kon-comments` is polymorphic: a comment hangs off `(subjectType,
 * subjectId)` with no foreign key, and that is why the same engine serves
 * articles, wiki pages and catalog entries without repeating threads, votes and
 * moderation five times. It is the right decision.
 *
 * But `subjectType` was only validated by SHAPE:
 *
 *     subjectType: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/)
 *
 * So `post`, `blog_post` and `blogpost` are all accepted and create THREE
 * different threads on the same article. Whoever writes the page picks one
 * string, whoever writes the sidebar widget picks another, and the comments
 * simply do not show up where expected. No error, no log, and nothing to
 * search for: both sides "work".
 *
 * ── WHY A VOCABULARY DOES NOT KILL POLYMORPHISM ────────────────────────────
 *
 * It might seem that closing the list contradicts the design. It does not: what
 * is closed is WRITING, and adding a type costs one line here. What used to be
 * a silent typo becomes a deliberate act. Reading still accepts any string,
 * because asking for a thread that does not exist returns an empty list and
 * breaks nothing.
 *
 * ── AND, WHILE AT IT, VISIBILITY ───────────────────────────────────────────
 *
 * Each entry says which table the subject is in and which of its states are
 * public. With that, `kon-comments` can check that the subject EXISTS and is
 * visible without importing a single kon: the table comes from this literal,
 * never from the request.
 *
 * Without that check, comments can be attached to the id of a draft, and
 * since reading threads is public, the thread of an unpublished article
 * would be readable from outside. It is the same family of leak that already
 * appeared in blog, games and esports.
 */

/** Something commentable: where it lives and when it is public. */
export interface CommentableSubject {
  /** For error messages and for the panel. */
  label: string;
  /** Who owns the subject. Documentary: nothing is imported here. */
  kon: string;
  /**
   * Table where it lives. It comes from this literal and NEVER from the request:
   * that is what allows interpolating it into a query without opening an injection.
   */
  table: string;
  /** Status column, if it has one. `null` = everything that exists is public. */
  statusColumn: string | null;
  /** States that a visitor without permissions can see. */
  publicStatuses: string[];

  /**
   * Column with the subject's human-readable name.
   *
   * ── WHY IT IS HERE ───────────────────────────────────────────────────────
   *
   * Without this, the moderation queue shows a comment body next to a
   * uuid. Whoever moderates needs to know WHICH article it comes from to decide:
   * the same text can be a legitimate reply in one thread and spam in another. It
   * is WordPress's "In response to" column, and without it moderating is guessing.
   */
  titleColumn: string;
  /** Slug column, so it can link to the public site. */
  slugColumn: string;
}

/**
 * The vocabulary.
 *
 * Only what really exists and is wired up. Declaring `game` or
 * `build` here before anything uses them would be inventing: an unused entry
 * is not reviewed, and the day someone uses it, it may point to a table that
 * was renamed.
 */
export const COMMENTABLE_SUBJECTS = {
  blog_post: {
    label: "Blog article",
    kon: "kon-blog",
    table: "blog_posts",
    statusColumn: "status",
    publicStatuses: ["published"],
    titleColumn: "title",
    slugColumn: "slug",
  },
  /**
   * A page of the block builder.
   *
   * It is here because the comments block says "empty = this page's subject",
   * and without this entry that sentence had nothing to refer to on a block
   * page: the vocabulary only knew articles. Promising a behavior that does
   * not exist sends people looking for a bug where there is none.
   */
  block_page: {
    label: "Builder page",
    kon: "kon-blocks",
    table: "block_pages",
    statusColumn: "status",
    publicStatuses: ["published"],
    titleColumn: "title",
    slugColumn: "slug",
  },
  /**
   * A page of a wiki (kon-wiki). Stateless: every page that exists is
   * public, and its content can be edited by any session.
   *
   * Used by the wiki entry page (`<wiki>.<domain>/<page>`), "Comments"
   * tab. The id is that of `wiki_pages`, not the slug: the slug is only
   * unique within its wiki.
   */
  wiki_page: {
    label: "Wiki page",
    kon: "kon-wiki",
    table: "wiki_pages",
    statusColumn: null,
    publicStatuses: [],
    titleColumn: "title",
    slugColumn: "slug",
  },
} as const satisfies Record<string, CommentableSubject>;

export type SubjectType = keyof typeof COMMENTABLE_SUBJECTS;

/** The valid types, for error messages that say which ones they are. */
export const SUBJECT_TYPES = Object.keys(COMMENTABLE_SUBJECTS) as SubjectType[];

export function isSubjectType(type: string): type is SubjectType {
  return Object.prototype.hasOwnProperty.call(COMMENTABLE_SUBJECTS, type);
}

export function commentableSubject(type: string): CommentableSubject | null {
  return isSubjectType(type) ? COMMENTABLE_SUBJECTS[type] : null;
}
