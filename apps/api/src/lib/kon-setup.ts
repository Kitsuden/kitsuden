/**
 * What the host does for a kon when it mounts it (docs/kons/README.md)
 * ============================================================================
 *
 * Two things, shared by the startup loader and by hot activation:
 *
 *   bindKonContext   the context the kon receives. It is the shared context
 *                    with `secrets`, `entities` and `automation` tied to THIS
 *                    kon: they take the kon's own id as their first argument
 *                    and refuse any other.
 *   announceKon      registers what the kon declared in `defineKon`: its
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
  KonAutomation,
  KonContext,
  KonDefinition,
  KonEntities,
  KonSecrets,
} from "@kitsuden/shared";

import { messageOf } from "../../../../packages/engine/src/errors";

import { registerKonContributions } from "./kon-contributions";
import { syncKonEntities } from "./kon-entities";
import { registerKonSecretColumns } from "./kon-secrets";

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

/** The context one kon receives: the shared one, with the kon-scoped services tied to `konId`. */
export function bindKonContext(base: KonContext, konId: string): KonContext {
  return {
    ...base,
    ...(base.secrets ? { secrets: bindSecrets(konId, base.secrets) } : {}),
    ...(base.entities ? { entities: bindEntities(konId, base.entities) } : {}),
    ...(base.automation ? { automation: bindAutomation(konId, base.automation) } : {}),
  };
}

/**
 * Registers what the kon declared. A malformed declaration is reported and
 * skipped: it must not take the kon's routes down with it.
 */
export async function announceKon(
  konDef: Pick<
    KonDefinition,
    "id" | "events" | "actionHandlers" | "reports" | "entities" | "secretColumns"
  >,
  context: KonContext,
  warn: (message: string) => void = (message) => console.warn(`  ⚠️  ${konDef.id}: ${message}`)
): Promise<void> {
  // Its events, its automation steps and its reports (lib/kon-contributions.ts).
  for (const problem of registerKonContributions(konDef, context)) warn(problem);

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
