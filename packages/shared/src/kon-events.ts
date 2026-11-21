/**
 * Kon events: the contract (docs/kons/events.md)
 * ============================================================================
 *
 * A kon tells the rest of the installation that something happened with
 * `ctx.events.emit("crm:deal.won", { ... })`. Another kon, or an automation rule
 * a person wrote in the panel, reacts to it. Neither side imports the other.
 *
 * What lives here is the part both sides must agree on: the shape of a name,
 * and the DECLARATION a kon makes of what it emits and what it listens to.
 * The declaration is what turns "grep the kon for emit(" into a catalog the
 * panel, an agent and the docs can read.
 *
 * ── THE NAME ───────────────────────────────────────────────────────────────
 *
 *   <source>:<entity>.<what-happened>        crm:deal.won   shop:order.paid
 *
 * `source` is the kon without its `kon-` prefix. `what-happened` is a past
 * participle: an event states a fact, it does not ask for anything. Older
 * events (`crm:deal:stage-changed`, `payment:subscription.created`) keep their
 * names: `KON_EVENT_NAME` accepts both separators, and renaming an event
 * breaks every rule that listens to it.
 *
 * ── WHAT THE HOST PROMISES ─────────────────────────────────────────────────
 *
 * See docs/kons/events.md. In short: delivered after the request commits,
 * never for a write that rolled back, in this process only, at most once.
 */

/** `<source>:<rest>`: lower case, digits, and `: . _ -` in the rest. */
export const KON_EVENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9:._-]{1,200}$/;

/** The recommended shape for a NEW event: `<source>:<entity>.<what-happened>`. */
export const KON_EVENT_RECOMMENDED = /^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;

export function isKonEventName(name: unknown): name is string {
  return typeof name === "string" && KON_EVENT_NAME.test(name);
}

/** One event a kon emits. */
export interface KonEventDeclaration {
  /** One sentence: what happened, in the past tense. */
  description: string;
  /**
   * The payload, field by field: `{ dealId: "uuid of the deal", amount: "number, in cents" }`.
   * Documentation, not validation: it is what a person reads when writing a
   * rule condition, and what an agent reads before listening.
   */
  payload?: Record<string, string>;
}

/** What a kon says about its events in `defineKon({ events })`. */
export interface KonEventsDeclaration {
  /** Events this kon emits, by full name. */
  emits?: Record<string, KonEventDeclaration>;
  /**
   * Events of OTHER kons this one reacts to. Declared so the catalog can
   * answer "who hears this?"; listening itself is still `ctx.events.on`.
   * A name that nobody emits is fine: the other kon may not be installed.
   */
  listens?: string[];
  /**
   * This kon's own events that ANY other kon may listen to: full names
   * (`blog:post.published`) or a prefix ending in `*` (`blog:post.*`).
   * Everything else this kon emits reaches only itself, the core and the
   * kons named in `subscribers` (docs/kons/events.md, "Who may listen").
   * A pattern outside the kon's own namespace has no effect.
   */
  public?: string[];
  /**
   * Other kons that may listen to some of this kon's events, by kon id:
   * `{ "kon-crm": ["shop:order.paid"], "kon-dc": ["shop:order.*"] }`.
   */
  subscribers?: Record<string, string[]>;
}

/**
 * An event name, or a prefix of one ending in `*`, as `public` and
 * `subscribers` take them. The namespace (before the first `:`) is always
 * spelled out: `*` alone, or `shop*`, would reach past the kon's own events.
 */
export const KON_EVENT_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,63}:(?:[a-z0-9:._-]{1,200}|[a-z0-9:._-]{0,200}\*)$/;

/** The namespace of an event (`shop` for `shop:order.paid`), or `null` when it has none. */
export function konEventNamespace(name: string): string | null {
  const at = name.indexOf(":");
  return at > 0 ? name.slice(0, at) : null;
}

/** Whether `name` is `pattern`, or starts with it when the pattern ends in `*`. */
export function matchesKonEventPattern(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/**
 * The declaration in code (`defineKon({ events })`) with the one in kon.json
 * (`"events": { ... }`) laid over it: lists are joined, `emits` and
 * `subscribers` merged by key. Either may be missing.
 */
export function mergeKonEventDeclarations(
  fromCode: KonEventsDeclaration | undefined,
  fromManifest: unknown
): KonEventsDeclaration | undefined {
  if (!fromManifest || typeof fromManifest !== "object" || Array.isArray(fromManifest)) {
    return fromCode;
  }
  const m = fromManifest as KonEventsDeclaration;
  if (!fromCode) return m;
  const join = (a?: string[], b?: string[]) =>
    a || b ? [...new Set([...(a ?? []), ...(Array.isArray(b) ? b : [])])] : undefined;
  const subscribers: Record<string, string[]> = { ...(fromCode.subscribers ?? {}) };
  for (const [kon, list] of Object.entries(m.subscribers ?? {})) {
    subscribers[kon] = join(subscribers[kon], list) ?? [];
  }
  const merged: KonEventsDeclaration = {
    ...fromCode,
    emits: { ...(fromCode.emits ?? {}), ...(m.emits ?? {}) },
  };
  const listens = join(fromCode.listens, m.listens);
  const pub = join(fromCode.public, m.public);
  if (listens) merged.listens = listens;
  if (pub) merged.public = pub;
  if (Object.keys(subscribers).length) merged.subscribers = subscribers;
  return merged;
}

/** A row of the catalog the host builds from every loaded kon. */
export interface KonEventCatalogEntry {
  name: string;
  /** The kon that declared it as emitted. */
  source: string;
  description: string;
  payload: Record<string, string>;
  /** Kons that declared they listen to it. */
  listeners: string[];
}

/**
 * Why a declaration cannot be accepted, or `null`. A kon with a malformed
 * event name is a programming error: better to say it at load than to have a
 * rule that never fires.
 */
export function konEventsProblem(declaration: KonEventsDeclaration | undefined): string | null {
  if (declaration === undefined) return null;
  for (const [name, entry] of Object.entries(declaration.emits ?? {})) {
    if (!isKonEventName(name)) {
      return `event name "${name}" must look like "<source>:<entity>.<what-happened>"`;
    }
    if (!entry || typeof entry.description !== "string" || entry.description.trim() === "") {
      return `event "${name}" needs a description`;
    }
  }
  for (const name of declaration.listens ?? []) {
    if (!isKonEventName(name)) {
      return `listened event name "${name}" must look like "<source>:<entity>.<what-happened>"`;
    }
  }
  if (declaration.public !== undefined && !Array.isArray(declaration.public)) {
    return `"public" must be a list of event names`;
  }
  for (const pattern of declaration.public ?? []) {
    if (typeof pattern !== "string" || !KON_EVENT_PATTERN.test(pattern)) {
      return `public event "${String(pattern)}" must be an event name, or a prefix of one ending in "*"`;
    }
  }
  const subscribers = declaration.subscribers;
  if (subscribers !== undefined) {
    if (!subscribers || typeof subscribers !== "object" || Array.isArray(subscribers)) {
      return `"subscribers" must map kon ids to lists of event names`;
    }
    for (const [konId, list] of Object.entries(subscribers)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(konId)) {
        return `subscriber "${konId}" must be a kon id`;
      }
      if (!Array.isArray(list)) return `subscriber "${konId}" needs a list of event names`;
      for (const pattern of list) {
        if (typeof pattern !== "string" || !KON_EVENT_PATTERN.test(pattern)) {
          return `event "${String(pattern)}" for subscriber "${konId}" must be an event name, or a prefix of one ending in "*"`;
        }
      }
    }
  }
  return null;
}

/** Builds the catalog from what each kon declared. Pure: the host keeps the map. */
export function buildKonEventCatalog(
  declarations: ReadonlyMap<string, KonEventsDeclaration>
): KonEventCatalogEntry[] {
  const listeners = new Map<string, string[]>();
  for (const [konId, declaration] of declarations) {
    for (const name of declaration.listens ?? []) {
      const list = listeners.get(name) ?? [];
      if (!list.includes(konId)) list.push(konId);
      listeners.set(name, list);
    }
  }
  const entries: KonEventCatalogEntry[] = [];
  for (const [konId, declaration] of declarations) {
    for (const [name, entry] of Object.entries(declaration.emits ?? {})) {
      entries.push({
        name,
        source: konId,
        description: entry.description,
        payload: entry.payload ?? {},
        listeners: (listeners.get(name) ?? []).slice().sort(),
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
