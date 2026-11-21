/**
 * Which queues a kon may handle and queue jobs on (docs/kons/queues.md)
 * ============================================================================
 *
 * The job queue is one table and one map of handlers for the whole process.
 * Before this module any kon could `queue.handle("koe-outbound", …)` and take
 * over another kon's work (its payloads, its retries), or the core's
 * (`kitsuden-email`), and any kon could queue jobs there. Queue names are now
 * scoped per kon, as events are (lib/kon-event-access.ts):
 *
 *   A KON'S NAMESPACE   `<short id>:` (`kon-crm` → `crm:sync`), `<kon id>:`
 *                       (`kon-crm:sync`), the event aliases
 *                       (`KON_EVENT_NAMESPACE_ALIASES`: `kon-ecommerce` → `shop:`)
 *                       and the legacy names in `KON_QUEUE_LEGACY_NAMES`.
 *   A PLAIN NAME        (`sync`, no namespace, owned by nobody) is MAPPED into
 *                       the kon's namespace: `handle("sync")` and
 *                       `dispatch("sync")` both use `crm:sync`. Jobs already
 *                       queued under `sync` are drained by the same handler
 *                       (the old name stays registered as an alias of that kon).
 *   HANDLE              only inside its namespace, and never a name the core or
 *                       another kon already handles.
 *   DISPATCH            inside its namespace; on another kon's queue only when
 *                       that kon opened it (`senders` in `handle`) or the core's
 *                       `LEGACY_QUEUE_GRANTS` list says so; never on a core queue
 *                       (`kitsuden-*`, `core:`, a queue the core handles) unless
 *                       `LEGACY_QUEUE_GRANTS` says so.
 *
 * Refusals throw: a job that silently went nowhere would be lost work.
 *
 * WHICH KON IS CALLING. Kons use `queue` from `@kitsuden/engine`, a module
 * shared by every kon, so the caller is known from the KON SCOPE: an
 * AsyncLocalStorage the host enters while it imports and starts a kon, for each
 * request to the kon's routes (REST and MCP), and around the kon's queue
 * handlers, event handlers, rule steps and schedules. `ctx.queue` (bound in
 * lib/kon-setup.ts) carries the kon's id itself and needs no scope. A call with
 * no scope (a callback the core runs from elsewhere) is only kept off the core's
 * queues. The core's own code imports the engine's `queue` directly and is not
 * checked.
 *
 * It is not a sandbox: a kon is code in the API process and can import the
 * raw queue. This stops one kon taking over another's queues through the API
 * the core hands it, and makes the refusal visible.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  configureKonQueueGuard,
  queue,
  queueHandlers,
  type DispatchOptions,
  type DispatchResult,
  type HandlerOptions,
  type QueueHandler,
} from "../../../../packages/engine/src/queue";

import { KON_EVENT_NAMESPACE_ALIASES, konEventNamespaces } from "./kon-event-access";

// ─────────────────────────────────────────────────────────────────────────────
// The kon scope: which kon's code is running
// ─────────────────────────────────────────────────────────────────────────────

const scope = new AsyncLocalStorage<string>();

/** Runs `fn` as kon `konId`: what it queues or handles through `@kitsuden/engine` is checked as that kon. */
export function runAsKon<T>(konId: string, fn: () => T): T {
  return scope.run(konId, fn);
}

/** The kon whose code is running, if the host knows it. */
export function currentKon(): string | undefined {
  return scope.getStore();
}

/** Runs `fn` with no kon scope (the queue worker: a job must not inherit whoever woke it). */
export function outsideKonScope<T>(fn: () => T): T {
  return scope.exit(fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/** The prefix of the core's own queues (`kitsuden-email`, `kitsuden-webhooks`…). */
export const CORE_QUEUE_PREFIX = "kitsuden-";

/** Namespaces (`<ns>:name`) no kon may use: the core's. */
const RESERVED_QUEUE_NAMESPACES = new Set([
  "agent",
  "agents",
  "auth",
  "core",
  "email",
  "kitsuden",
  "kon",
  "mail",
  "system",
]);

/**
 * Queue names the published kons used before the rule "namespace = short id"
 * (Kitsuden/kitsuden-kons). They keep their names, so jobs already queued
 * under them keep running, and the name belongs to that kon. `*` at the end is
 * a prefix. New queues go in `<short id>:`.
 */
export const KON_QUEUE_LEGACY_NAMES: Readonly<Record<string, readonly string[]>> = {
  "kon-chat": ["chat-channel-turns"],
  "kon-ingest": ["kitsuden-ingest"],
  "kon-koe": ["koe-*"],
};

/**
 * Queues a published kon queues jobs on without owning them, by kon. The core
 * allows these so the kons keep working; an entry can go once the owner opens
 * the queue with `senders` (or, for a core queue, the core offers an API).
 */
export const LEGACY_QUEUE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // A channel bot's answer, back on the queue koe named in the turn (`replyQueue`).
  "kon-chat": ["koe-bot-replies"],
  // The embedding of each chunk, as defineModel queues it.
  "kon-ingest": ["kitsuden-embeddings"],
  // A channel bot turn for kon-chat.
  "kon-koe": ["chat-channel-turns"],
};

const VALID_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;

function shortId(konId: string): string {
  return konId.replace(/^kon-/, "");
}

function matches(patterns: readonly string[] | undefined, name: string): boolean {
  return (patterns ?? []).some((p) =>
    p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name
  );
}

/** The namespaces a kon's queue names may start with (`<ns>:`). */
export function konQueueNamespaces(konId: string): string[] {
  const own = new Set<string>(konEventNamespaces(konId));
  own.add(konId);
  return [...own].filter((ns) => !RESERVED_QUEUE_NAMESPACES.has(ns));
}

function namespaceOf(name: string): string | null {
  const i = name.indexOf(":");
  return i > 0 ? name.slice(0, i) : null;
}

function legacyOwner(name: string): string | null {
  for (const [konId, list] of Object.entries(KON_QUEUE_LEGACY_NAMES)) {
    if (matches(list, name)) return konId;
  }
  return null;
}

/** The kon a `<ns>:` namespace belongs to: `kon-<id>:`, an event alias, else `kon-<ns>`. */
function namespaceOwner(ns: string): string {
  if (ns.startsWith("kon-")) return ns;
  for (const [konId, list] of Object.entries(KON_EVENT_NAMESPACE_ALIASES)) {
    if (list.includes(ns)) return konId;
  }
  return `kon-${ns}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Who handles what
// ─────────────────────────────────────────────────────────────────────────────

interface Owner {
  /** `null`: registered by kon code the host could not tell (no scope). */
  konId: string | null;
  senders?: readonly string[];
  /** Set on an old plain name kept as an alias: the name its jobs now go to. */
  canonical?: string;
}

/** Queues registered by kons through this module. A handled queue missing here is the core's. */
const owners = new Map<string, Owner>();

function coreHandles(name: string): boolean {
  return queueHandlers().has(name) && !owners.has(name);
}

type Verdict =
  | { kind: "own"; queue: string; mapped: boolean }
  | { kind: "core"; queue: string }
  | { kind: "kon"; queue: string; owner: string };

/** What a name means for one kon: its own (maybe mapped), the core's, or another kon's. */
function classify(konId: string, name: string): Verdict {
  const ns = namespaceOf(name);
  if (ns !== null) {
    if (konQueueNamespaces(konId).includes(ns)) return { kind: "own", queue: name, mapped: false };
    if (RESERVED_QUEUE_NAMESPACES.has(ns) || ns.startsWith("kitsuden")) {
      return { kind: "core", queue: name };
    }
    const owner = namespaceOwner(ns);
    if (owner === konId) return { kind: "own", queue: name, mapped: false };
    return { kind: "kon", queue: name, owner };
  }
  const legacy = legacyOwner(name);
  if (legacy === konId) return { kind: "own", queue: name, mapped: false };
  if (legacy) return { kind: "kon", queue: name, owner: legacy };
  const known = owners.get(name);
  if (known?.konId === konId) {
    return known.canonical
      ? { kind: "own", queue: known.canonical, mapped: true }
      : { kind: "own", queue: name, mapped: false };
  }
  if (known?.konId) return { kind: "kon", queue: name, owner: known.konId };
  if (name.startsWith(CORE_QUEUE_PREFIX) || coreHandles(name)) return { kind: "core", queue: name };
  const namespaces = konQueueNamespaces(konId);
  const primary = namespaces.includes(shortId(konId)) ? shortId(konId) : konId;
  return { kind: "own", queue: `${primary}:${name}`, mapped: true };
}

/** A core queue, for a caller the host could not identify. */
function isCoreQueue(name: string): boolean {
  if (legacyOwner(name)) return false;
  const ns = namespaceOf(name);
  if (ns !== null) return RESERVED_QUEUE_NAMESPACES.has(ns) || ns.startsWith("kitsuden");
  return name.startsWith(CORE_QUEUE_PREFIX) || coreHandles(name);
}

function validName(name: unknown): string {
  if (typeof name !== "string" || !VALID_NAME.test(name)) {
    throw new TypeError(
      `Name of the queue is invalid: "${String(name)}" (letters, digits and _.:- up to 120)`
    );
  }
  return name;
}

/** A kon asked for a queue that is not its own. */
export class KonQueueRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KonQueueRefused";
  }
}

const reported = new Set<string>();

function reportOnce(key: string, message: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`  ⚠️  ${message}`);
}

function namespacesText(konId: string): string {
  return konQueueNamespaces(konId)
    .map((ns) => `${ns}:`)
    .concat(KON_QUEUE_LEGACY_NAMES[konId] ?? [])
    .join(", ");
}

/** Whether the old plain name of a mapped queue keeps being drained (`KON_QUEUE_LEGACY_DRAIN=false` turns it off). */
function drainLegacy(): boolean {
  return process.env.KON_QUEUE_LEGACY_DRAIN !== "false";
}

// ─────────────────────────────────────────────────────────────────────────────
// The two checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kon `konId` (`undefined`: not known) registers a handler for `name`: the name
 * it is registered under and the handler to register (it runs as that kon).
 * Throws when the queue is not the kon's.
 */
export function checkKonHandle(
  konId: string | undefined,
  name: string,
  fn: QueueHandler,
  options: HandlerOptions = {}
): { queue: string; fn: QueueHandler } {
  validName(name);
  if (!konId) {
    if (isCoreQueue(name)) {
      throw new KonQueueRefused(`A kon cannot handle "${name}": it is one of the core's queues`);
    }
    const holder = owners.get(name);
    if (holder?.konId) {
      throw new KonQueueRefused(
        `A kon cannot handle "${name}" outside its scope: ${holder.konId} already handles it`
      );
    }
    reportOnce(
      `handle:?:${name}`,
      `a kon registered the queue "${name}" outside its scope; it is kept as is`
    );
    if (!owners.get(name)?.konId) owners.set(name, { konId: null, senders: options.senders });
    return { queue: name, fn };
  }
  const verdict = classify(konId, name);
  if (verdict.kind === "core") {
    throw new KonQueueRefused(
      `${konId} cannot handle "${name}": it is one of the core's queues. A kon's queues are ${namespacesText(konId)}`
    );
  }
  if (verdict.kind === "kon") {
    throw new KonQueueRefused(
      `${konId} cannot handle "${name}": it belongs to ${verdict.owner}. A kon's queues are ${namespacesText(konId)}`
    );
  }
  const target = verdict.queue;
  const holder = owners.get(target);
  if (coreHandles(target) || (holder?.konId && holder.konId !== konId)) {
    throw new KonQueueRefused(
      `${konId} cannot handle "${target}": ${holder?.konId ?? "the core"} already handles it`
    );
  }
  owners.set(target, { konId, senders: options.senders });
  const scoped: QueueHandler = (job) => runAsKon(konId, () => fn(job));

  if (verdict.mapped && target !== name) {
    // The old plain name: jobs already queued there go to the same handler, as long as it is free.
    const old = owners.get(name);
    const free = !queueHandlers().has(name) || old?.konId === konId || old?.konId === null;
    if (drainLegacy() && free) {
      owners.set(name, { konId, senders: options.senders, canonical: target });
      queue.handle(name, scoped, options);
      reportOnce(
        `map:${konId}:${name}`,
        `${konId} handles the queue "${name}" as "${target}"; jobs still queued under "${name}" are drained by the same handler`
      );
    } else {
      reportOnce(
        `map:${konId}:${name}`,
        `${konId} handles the queue "${name}" as "${target}"; jobs still queued under "${name}" are not drained`
      );
    }
  }
  return { queue: target, fn: scoped };
}

function senderMatches(senders: readonly string[] | undefined, konId: string): boolean {
  return (senders ?? []).some((s) => s === "*" || s === konId || s === shortId(konId));
}

/**
 * Kon `konId` (`undefined`: not known) queues a job on `name`: the name it is
 * queued on. Throws when the kon may not queue there.
 */
export function checkKonDispatch(konId: string | undefined, name: string): string {
  validName(name);
  if (!konId) {
    if (isCoreQueue(name)) {
      throw new KonQueueRefused(
        `A kon cannot queue jobs on "${name}": it is one of the core's queues`
      );
    }
    return name;
  }
  const verdict = classify(konId, name);
  if (verdict.kind === "own") return verdict.queue;
  if (matches(LEGACY_QUEUE_GRANTS[konId], verdict.queue)) return verdict.queue;
  if (verdict.kind === "kon") {
    const holder = owners.get(verdict.queue);
    if (holder?.konId === verdict.owner && senderMatches(holder.senders, konId)) {
      return verdict.queue;
    }
    throw new KonQueueRefused(
      `${konId} cannot queue jobs on "${name}": it belongs to ${verdict.owner}, which has not opened it to ${konId} (\`senders\` in its queue.handle)`
    );
  }
  throw new KonQueueRefused(
    `${konId} cannot queue jobs on "${name}": it is one of the core's queues`
  );
}

/** The name a kon's queue resolves to (`sync` → `crm:sync`). Throws when it is not the kon's. */
export function konQueueName(konId: string, name: string): string {
  validName(name);
  const verdict = classify(konId, name);
  if (verdict.kind !== "own") {
    throw new KonQueueRefused(`"${name}" is not one of ${konId}'s queues`);
  }
  return verdict.queue;
}

// ─────────────────────────────────────────────────────────────────────────────
// The binding
// ─────────────────────────────────────────────────────────────────────────────

/** `ctx.queue` for one kon: the same checks, with the kon's id instead of the scope. */
export function bindKonQueue(konId: string) {
  return {
    async add<T>(
      name: string,
      job: string,
      payload: T,
      options?: DispatchOptions
    ): Promise<DispatchResult> {
      return queue.dispatch(checkKonDispatch(konId, name), job, payload, options);
    },
    handle<T>(name: string, fn: QueueHandler<T>, options: HandlerOptions = {}): void {
      const checked = checkKonHandle(konId, name, fn as QueueHandler, options);
      queue.handle(checked.queue, checked.fn, options);
    },
    name: (name: string) => konQueueName(konId, name),
  };
}

/** Puts the checks behind `@kitsuden/engine`'s `queue` (idempotent). */
export function installKonQueueGuard(): void {
  configureKonQueueGuard({
    handle: (name, fn, options) => checkKonHandle(currentKon(), name, fn, options),
    dispatch: (name) => checkKonDispatch(currentKon(), name),
  });
}

/** For tests: forget who handles what and every logged notice. */
export function resetKonQueueAccessForTests(): void {
  owners.clear();
  reported.clear();
}
