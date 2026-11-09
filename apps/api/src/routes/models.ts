/**
 * GET /api/models — the models (defineModel) of the mounted kons
 * ============================================================================
 *
 * The panel generates its view of each model (list, create, edit) from
 * its DESCRIPTOR: fields, types, access policy, scopes and where the
 * collection lives. This route gathers those of all the mounted kons so
 * the panel knows what exists; each model also publishes its own at
 * `GET <mount>/<plural>/_model` (operation `describe-<model>`, which is
 * an MCP tool).
 *
 * It is an operation of the CORE SDK (`kon-models`), not of a kon: no
 * `kon:*` opens it. For the team (admin, editor) and agents with `admin`.
 */

import {
  defineOperation,
  mountedModels,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import { modelDescriptorSchema } from "@kitsuden/shared";
import { z } from "zod";

import { registerCoreOperations } from "../lib/core-operations";
import { optionalAuth, requireAuth } from "../middleware/auth";

export const MODELS_ROUTE = "/api/models";

const MountedModel = z.object({
  kon: z.string(),
  mountPath: z.string(),
  base: z.string(),
  descriptor: modelDescriptorSchema,
});

export const modelsOperations: AnyOperation[] = [
  defineOperation({
    id: "list-models",
    method: "GET",
    route: "/",
    summary: "List the declared models",
    description:
      "Every model declared with defineModel in a mounted kon: its descriptor (fields, access policy, scopes) and the base path of its REST collection. The admin panel builds its model views from this.",
    tags: ["models"],
    output: { schema: z.object({ data: z.array(MountedModel) }) },
    access: "session",
    permission: { roles: ["admin", "editor"] },
    mcp: {
      exclude:
        "Panel listing. An agent reads each model with its own describe-<model> tool (and only the models its scopes open).",
    },
    handle: () => ({
      data: mountedModels().map((m) => ({
        kon: m.konId,
        mountPath: m.mountPath,
        base: m.base,
        descriptor: m.descriptor,
      })),
    }),
  }),
];

export const modelsKon = {
  id: "kon-models",
  name: "Declared models",
  version: "1.0.0",
  mountPath: MODELS_ROUTE,
  operations: modelsOperations,
};

registerCoreOperations({
  konId: "kon-models",
  mountPath: MODELS_ROUTE,
  description: "The models declared with defineModel in the mounted kons (for the admin panel).",
  operations: modelsOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const modelsRoutes = operationsRouter("kon-models", modelsOperations, context);
