/**
 * Who may emit and who may hear a kon event (docs/kons/events.md)
 * ============================================================================
 *
 * The event bus (lib/events.ts) is one in-process emitter. Before this module
 * any kon could `ctx.events.on("koe:message.received")` and get another kon's
 * payloads (a visitor's message text, an order's buyer email), and any kon
 * could emit under another kon's name or the core's (`entry:created`). Each
 * kon now gets `ctx.events` bound to its id (lib/kon-setup.ts):
 *
 *   EMIT   only under its own namespaces: its short id (`kon-crm` → `crm:`)
 *          plus the legacy names in `KON_EVENT_NAMESPACE_ALIASES`. Anything
 *          else is dropped and logged; the request is not failed.
 *
 *   LISTEN freely to its own namespaces and to the core's events
 *          (`CORE_EVENT_NAMESPACES`). Another kon's event is delivered only
 *          when the emitting kon allows it: `events.public` (any kon) or
 *          `events.subscribers["<listener id>"]`, declared in `defineKon` or
 *          kon.json. Two built-in lists keep what worked before working:
 *          `DEFAULT_PUBLIC_EVENTS` and `LEGACY_EVENT_GRANTS`. Otherwise the
 *          handler is not called and the refusal is logged once per pair.
 *
 * The check runs at DELIVERY, not only at subscription: the emitting kon may
 * load after the listener, and its declaration is what decides.
 *
 * It is not a sandbox. A kon is code running in the API process and can
 * import the bus itself; this binding stops one kon reading or forging
 * another's events through the API the core hands it, and makes the refusal
 * visible. Installing a kon is still a decision to trust it.
 *
 * Pure apart from the module-level registry: no database, no logger import
 * (the loader's kon messages go to the console too), so tests load it alone.
 */

import {
  isKonEventName,
  konEventNamespace,
  matchesKonEventPattern,
  type KonEvents,
  type KonEventsDeclaration,
} from "@kitsuden/shared";

/**
 * Namespaces the core emits in. Any kon may listen to them; no kon may emit
 * in them unless `KON_EVENT_NAMESPACE_ALIASES` gives it one (`kon-datasets`,
 * the core's own datasets module, emits `entry:` and `dataset:`).
 */
export const CORE_EVENT_NAMESPACES: readonly string[] = [
  "auth",
  "connections",
  "dataset",
  "entry",
  // The page builder (`kon-blocks`, a core module): page:updated / page:deleted, heard by
  // visual editors and the site cache.
  "page",
  "post",
];

/** Reserved for the core as well, though nothing is emitted there yet. */
const RESERVED_NAMESPACES = new Set([
  ...CORE_EVENT_NAMESPACES,
  "core",
  "kitsuden",
  "kon",
  "system",
]);

/**
 * Kons whose events were named before the rule "namespace = short id". They
 * keep their names (renaming an event breaks every rule on it), and the
 * namespace belongs to them: a `kon-shop` does not get `shop:`.
 */
export const KON_EVENT_NAMESPACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "kon-blocks": ["page"],
  "kon-datasets": ["dataset", "entry"],
  "kon-ecommerce": ["shop"],
  "kon-payments": ["payment"],
};

/** Events any kon may hear, whatever the emitter declares: what is already public. */
export const DEFAULT_PUBLIC_EVENTS: readonly string[] = [
  // A published post is public content; kon-newsletter's auto-send listens to it.
  "blog:post:published",
];

/**
 * The cross-kon subscriptions the published kons made before emitters could
 * declare who may listen, by listener. Each entry is an event a kon in
 * Kitsuden/kitsuden-kons hears today. New subscriptions go in the emitting
 * kon's `events.public` or `events.subscribers`, not here; an entry can go
 * once the emitter declares it.
 */
export const LEGACY_EVENT_GRANTS: Readonly<Record<string, readonly string[]>> = {
  "kon-crm": [
    "shop:order.paid",
    "payment:payment.succeeded",
    "payment:payment.refunded",
    "newsletter:member.subscribed",
    "newsletter:address.suppressed",
    "newsletter:address.unsuppressed",
  ],
  "kon-ecommerce": ["payment:payment.succeeded", "payment:payment.refunded", "crm:quote.accepted"],
  "kon-members": ["payment:subscription.*", "payment:payment.failed", "payment:payment.refunded"],
  "kon-newsletter": ["crm:address.suppressed", "crm:address.unsuppressed"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Who owns a namespace, and what its owner shares
// ─────────────────────────────────────────────────────────────────────────────

const sharing = new Map<string, Pick<KonEventsDeclaration, "public" | "subscribers">>();

function shortId(konId: string): string {
  return konId.replace(/^kon-/, "");
}

function aliasOwner(namespace: string): string | null {
  for (const [konId, list] of Object.entries(KON_EVENT_NAMESPACE_ALIASES)) {
    if (list.includes(namespace)) return konId;
  }
  return null;
}

/** The namespaces a kon emits in. */
export function konEventNamespaces(konId: string): string[] {
  const own = [...(KON_EVENT_NAMESPACE_ALIASES[konId] ?? [])];
  const short = shortId(konId);
  const ownerOfShort = aliasOwner(short);
  if (!RESERVED_NAMESPACES.has(short) && (ownerOfShort === null || ownerOfShort === konId)) {
    if (!own.includes(short)) own.push(short);
  }
  return own;
}

/** The kon that owns a namespace: the alias table, else `kon-<namespace>`. */
function namespaceOwner(namespace: string): string {
  return aliasOwner(namespace) ?? `kon-${namespace}`;
}

/** What a kon shares, from its declaration. Called by the loader with every kon it announces. */
export function setKonEventSharing(
  konId: string,
  declaration: KonEventsDeclaration | undefined
): string[] {
  const problems: string[] = [];
  if (!declaration || (!declaration.public && !declaration.subscribers)) {
    sharing.delete(konId);
    return problems;
  }
  const own = konEventNamespaces(konId);
  const outside = (pattern: string) => !own.includes(konEventNamespace(pattern) ?? "");
  for (const pattern of declaration.public ?? []) {
    if (outside(pattern)) {
      problems.push(`events.public: "${pattern}" is not in this kon's namespace; ignored`);
    }
  }
  for (const [listener, list] of Object.entries(declaration.subscribers ?? {})) {
    for (const pattern of list) {
      if (outside(pattern)) {
        problems.push(
          `events.subscribers["${listener}"]: "${pattern}" is not in this kon's namespace; ignored`
        );
      }
    }
  }
  sharing.set(konId, { public: declaration.public, subscribers: declaration.subscribers });
  return problems;
}

/** Forgets what a kon shared (it was turned off, or is being announced again). */
export function forgetKonEventSharing(konId: string): void {
  sharing.delete(konId);
}

function sharedBy(owner: string): Pick<KonEventsDeclaration, "public" | "subscribers"> | undefined {
  // `kon-blog` may also have been loaded as `blog`.
  return sharing.get(owner) ?? sharing.get(shortId(owner));
}

// ─────────────────────────────────────────────────────────────────────────────
// The two questions
// ─────────────────────────────────────────────────────────────────────────────

/** Whether `konId` may emit `name`. */
export function mayEmitKonEvent(konId: string, name: unknown): boolean {
  if (!isKonEventName(name)) return false;
  return konEventNamespaces(konId).includes(konEventNamespace(name) ?? "");
}

/** Whether `konId` may hear `name`. */
export function mayListenToKonEvent(konId: string, name: unknown): boolean {
  if (typeof name !== "string" || name === "") return false;
  const namespace = konEventNamespace(name);
  // A name with no namespace (`entry.created`) is the core's old dotted form.
  if (namespace === null) return true;
  if (CORE_EVENT_NAMESPACES.includes(namespace)) return true;
  if (konEventNamespaces(konId).includes(namespace)) return true;
  const matches = (list: readonly string[] | undefined) =>
    (list ?? []).some((pattern) => matchesKonEventPattern(pattern, name));
  if (matches(DEFAULT_PUBLIC_EVENTS)) return true;
  if (matches(LEGACY_EVENT_GRANTS[konId])) return true;
  const owner = namespaceOwner(namespace);
  const shared = sharedBy(owner);
  if (!shared) return false;
  // Patterns the owner wrote for someone else's namespace never count.
  const own = (list: readonly string[] | undefined) =>
    (list ?? []).filter((pattern) => konEventNamespace(pattern) === namespace);
  if (matches(own(shared.public))) return true;
  const subscribers = shared.subscribers ?? {};
  return matches(own(subscribers[konId])) || matches(own(subscribers[shortId(konId)]));
}

// ─────────────────────────────────────────────────────────────────────────────
// The binding
// ─────────────────────────────────────────────────────────────────────────────

const reported = new Set<string>();

function reportOnce(key: string, message: string, report: (message: string) => void): void {
  if (reported.has(key)) return;
  reported.add(key);
  report(message);
}

const consoleReport = (message: string) => console.warn(`  ⚠️  ${message}`);

/**
 * `ctx.events` for one kon: emits only in its namespaces, and delivers
 * another kon's event only when that kon allows it.
 */
export function bindKonEvents(
  konId: string,
  base: KonEvents,
  report: (message: string) => void = consoleReport
): KonEvents {
  return {
    emit: (event: string, data: unknown) => {
      if (!mayEmitKonEvent(konId, event)) {
        reportOnce(
          `emit:${konId}:${String(event)}`,
          `${konId} emitted "${String(event)}" outside its namespaces ` +
            `(${konEventNamespaces(konId).join(", ") || "none"}); the event was dropped`,
          report
        );
        return;
      }
      base.emit(event, data);
    },
    on: (event: string, handler: (data: unknown) => void) => {
      if (typeof event !== "string" || typeof handler !== "function") return;
      const refusal = () =>
        `${konId} listens to "${event}", which its emitter does not share with it; ` +
        `the emitting kon must list it in events.public or events.subscribers["${konId}"]`;
      if (!mayListenToKonEvent(konId, event)) {
        reportOnce(`on:${konId}:${event}`, `${refusal()} (it will not be delivered)`, report);
      }
      base.on(event, (data: unknown) => {
        // At delivery: the emitter's declaration may have arrived after the subscription.
        if (!mayListenToKonEvent(konId, event)) {
          reportOnce(`on:${konId}:${event}`, `${refusal()} (not delivered)`, report);
          return;
        }
        handler(data);
      });
    },
  };
}

/** For tests: forget every declaration and every logged refusal. */
export function resetKonEventAccessForTests(): void {
  sharing.clear();
  reported.clear();
}
