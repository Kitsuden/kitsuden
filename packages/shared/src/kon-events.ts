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
