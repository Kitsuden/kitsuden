/**
 * What the host does for a kon when it mounts it (docs/kons/README.md)
 * ============================================================================
 *
 * Two things, shared by the startup loader and by hot activation:
 *
 *   bindKonContext   the context the kon receives. It is the shared context
 *                    with `secrets`, `entities` and `automation` tied to THIS
 *                    kon: they take the kon's own id as their first argument
 *                    and refuse any other. `realtime.channels` registers the
 *                    authorizer of the kon's own channel namespace only.
 *                    `events` emits only in the kon's namespace and delivers
 *                    another kon's event only when that kon shares it.
 *                    `queue` handles and queues only in the kon's own
 *                    namespace (lib/queue-kon-access.ts).
 *   announceKon     registers what the kon declared in `defineKon`: its
 *                    events, automation steps, reports, entities and secret
 *                    columns.
 *
 * ── WHAT THE BINDING IS, AND IS NOT ────────────────────────────────────────
 *
 * Every kon used to receive the same context object, and `konId` is an
 * argument, so a kon could pass another kon's id: open its sealed secrets, list
 * its rules, drop its entities, and have the access log blame the other kon.
 * Now the wrapper throws when the id is not the kon's own.
 *
 * It is not a sandbox. A kon is code running in the API process, with its own
 * database connection and the environment (including the secrets key), and a
 * hostile one can read what it wants. The binding makes the audit trail
 * truthful and stops one kon acting as another by mistake or by a copied
 * snippet; installing a kon is still a decision to trust it.
 */

import type {
  KonAgentRun,
  KonAutomation,
  KonConnections,
  KonContext,
  KonDefinition,
  KonEntities,
  KonEvents,
  KonQueue,
  KonSecrets,
} from "@kitsuden/shared";

import { messageOf } from "../../../../packages/engine/src/errors";

import { registerKonContributions } from "./kon-contributions";
import { syncKonEntities } from "./kon-entities";
import { bindKonEvents } from "./kon-event-access";
import { registerKonSchedules } from "./kon-schedules";
import { registerKonSecretColumns } from "./kon-secrets";
import { bindKonQueue, installKonQueueGuard, runAsKon } from "./queue-kon-access";
import { konCapability, konMayBroadcast, registerKonChannels } from "./realtime-kon-channels";

// `queue` from `@kitsuden/engine` checks every kon's queue names from now on (lib/queue-kon-access.ts).
// Here, because every kon the host loads is bound by this module first.
installKonQueueGuard();

function own(owner: string, given: unknown, what: string): void {
  if (given !== owner) {
    throw new Error(`${what}: this kon is "${owner}" and cannot act as "${String(given)}"`);
  }
}

function bindSecrets(owner: string, base: KonSecrets): KonSecrets {
  return {
    seal: (konId, plaintext) => {
      own(owner, konId, "secrets.seal");
      return base.seal(konId, plaintext);
    },
    open: async (konId, sealed, access) => {
      own(owner, konId, "secrets.open");
      return base.open(konId, sealed, access);
    },
  };
}

function bindEntities(owner: string, base: KonEntities): KonEntities {
  return {
    ...base,
    define: async (konId, definition) => {
      own(owner, konId, "entities.define");
      return base.define(konId, definition);
    },
    undefine: async (konId, slug, options) => {
      own(owner, konId, "entities.undefine");
      return base.undefine(konId, slug, options);
    },
    definitions: async (konId) => {
      own(owner, konId, "entities.definitions");
      return base.definitions(konId);
    },
  };
}

function bindConnections(owner: string, base: KonConnections): KonConnections {
  return {
    client: async (konId, request) => {
      own(owner, konId, "connections.client");
      return base.client(konId, request);
    },
    registerProvider: (konId, provider) => {
      own(owner, konId, "connections.registerProvider");
      base.registerProvider(konId, provider);
    },
    visible: async (konId, connectionId) => {
      own(owner, konId, "connections.visible");
      return base.visible(konId, connectionId);
    },
    covers: (provider, granted, scopeSets) => base.covers(provider, granted, scopeSets),
  };
}

function bindAutomation(owner: string, base: KonAutomation): KonAutomation {
  return {
    upsertRule: async (konId, rule) => {
      own(owner, konId, "automation.upsertRule");
      return base.upsertRule(konId, rule);
    },
    removeRule: async (konId, slug) => {
      own(owner, konId, "automation.removeRule");
      return base.removeRule(konId, slug);
    },
    listRules: async (konId) => {
      own(owner, konId, "automation.listRules");
      return base.listRules(konId);
    },
  };
}

/**
 * What a kon's `ctx.agents.run` hands the engine: the `KonAgentRun` fields and
 * nothing else (H70). Spreading the kon's options let a kon in plain JS pass
 * engine-only ones (`holdWrites`, `enableMemory`, a user to act as). Memory and
 * brain notes stay off: one agent serves every visitor of a kon, and they are
 * shared by all its sessions.
 */
export function konAgentRunOptions(options: KonAgentRun) {
  const { agentId, message, sessionId, history, context, allowedTools, toolset, onEvent } =
    options ?? ({} as KonAgentRun);
  return {
    agentId,
    message,
    sessionId,
    history,
    context,
    allowedTools,
    toolset,
    onEvent,
    enableMemory: false,
    enableBrainSearch: false,
  };
}

const warned = new Set<string>();

/** One console line per kon and refusal: a kon that broadcasts in a loop does not flood the log. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`  ⚠️  ${message}`);
}

/** The context one kon receives: the shared one, with the kon-scoped services tied to `konId`. */
export function bindKonContext(base: KonContext, konId: string): KonContext {
  // This binding: what tells one loaded kon from another with the same id (realtime channels).
  const binding = {};
  return {
    ...base,
    ...(base.secrets ? { secrets: bindSecrets(konId, base.secrets) } : {}),
    ...(base.entities ? { entities: bindEntities(konId, base.entities) } : {}),
    ...(base.automation ? { automation: bindAutomation(konId, base.automation) } : {}),
    // Its own realtime namespace, `kon:<short id>:` (lib/realtime-kon-channels.ts).
    ...(base.realtime
      ? {
          realtime: {
            ...base.realtime,
            channels: (authorize) => registerKonChannels(konId, authorize, binding),
            // Only on its own channels: not `table:`/`entry:` (forged change events) nor another kon's (H19).
            broadcast: (channel: string, message: unknown) => {
              if (!konMayBroadcast(konId, channel)) {
                warnOnce(
                  `broadcast:${konId}:${String(channel).split(":")[0]}`,
                  `${konId} broadcast on "${String(channel)}", outside kon:${konId.replace(/^kon-/, "")}:; dropped`
                );
                return;
              }
              base.realtime!.broadcast(channel, message);
            },
            // Keyed by the installation's secret and this kon's id: a value read from the kon's tables
            // does not give the channel (lib/realtime-kon-channels.ts).
            capability: (material: string) => konCapability(konId, material),
          },
        }
      : {}),
    ...(base.connections ? { connections: bindConnections(konId, base.connections) } : {}),
    // Emits only in its own namespace; hears another kon's events only when that kon shares them
    // (lib/kon-event-access.ts). Its handlers run in its kon scope (what they queue is checked as it).
    ...(base.events ? { events: scopedEvents(konId, bindKonEvents(konId, base.events)) } : {}),
    // Its own queues: `<short id>:`, a plain name mapped into it (lib/queue-kon-access.ts).
    queue: bindKonQueue(konId) as KonQueue,
  };
}

function scopedEvents(konId: string, events: KonEvents): KonEvents {
  return {
    ...events,
    on: (event, handler) =>
      events.on(
        event,
        typeof handler === "function"
          ? (data: unknown) => runAsKon(konId, () => handler(data))
          : handler
      ),
  };
}

/**
 * The kon's rule steps and schedules, run in its kon scope: the core calls them from a rule or a
 * queue job, and what they queue through `@kitsuden/engine` must be checked as this kon.
 */
function scopedCallbacks<T extends Pick<KonDefinition, "id" | "actionHandlers" | "schedules">>(
  konDef: T
): T {
  const konId = konDef.id;
  return {
    ...konDef,
    ...(konDef.actionHandlers
      ? {
          actionHandlers: konDef.actionHandlers.map((h) =>
            h && typeof h === "object"
              ? {
                  ...h,
                  ...(typeof h.run === "function"
                    ? { run: (input, ctx) => runAsKon(konId, () => h.run(input, ctx)) }
                    : {}),
                  ...(typeof h.preview === "function"
                    ? { preview: (input, ctx) => runAsKon(konId, () => h.preview!(input, ctx)) }
                    : {}),
                }
              : h
          ) as KonDefinition["actionHandlers"],
        }
      : {}),
    ...(konDef.schedules
      ? {
          schedules: konDef.schedules.map((s) =>
            s && typeof s === "object" && typeof s.run === "function"
              ? { ...s, run: (ctx, tick) => runAsKon(konId, () => s.run(ctx, tick)) }
              : s
          ) as KonDefinition["schedules"],
        }
      : {}),
  };
}

/**
 * Registers what the kon declared. A malformed declaration is reported and
 * skipped: it must not take the kon's routes down with it.
 */
export async function announceKon(
  konDef: Pick<
    KonDefinition,
    "id" | "events" | "actionHandlers" | "reports" | "entities" | "secretColumns" | "schedules"
  >,
  context: KonContext,
  warn: (message: string) => void = (message) => console.warn(`  ⚠️  ${konDef.id}: ${message}`)
): Promise<void> {
  // Its steps and schedules run in its kon scope (lib/queue-kon-access.ts).
  const scoped = scopedCallbacks(konDef);
  // Its events, its automation steps and its reports (lib/kon-contributions.ts).
  for (const problem of registerKonContributions(scoped, context)) warn(problem);

  // Its periodic tasks: one run per tick across every replica (lib/kon-schedules.ts).
  for (const problem of registerKonSchedules(scoped, context)) warn(problem);

  // The entities it owns: one dataset each, created here with no migration (lib/kon-entities.ts).
  if (konDef.entities) {
    for (const problem of await syncKonEntities(konDef.id, konDef.entities)) warn(problem);
  }

  // Where it keeps sealed secrets, so a key rotation reaches them (lib/kon-secrets.ts).
  if (konDef.secretColumns) {
    try {
      for (const problem of await registerKonSecretColumns(konDef.id, konDef.secretColumns)) {
        warn(problem);
      }
    } catch (err: unknown) {
      warn(
        `its secret columns were not recorded (${messageOf(err)}); a key rotation would miss them`
      );
    }
  }
}
