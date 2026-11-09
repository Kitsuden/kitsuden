/**
 * SDK operations mounted by the CORE (not a kon)
 * ============================================================================
 *
 * The agent permission routes (`kon-agents`, /api/v1), the human
 * approval ones (`kon-approvals`, /api/approvals) and the proposal status
 * for the agent (`kon-proposals`, /api/proposals) are declared with
 * the SDK but are NOT registered among the kons' mounted operations: that way
 * no fine-grained scope (`kon:*`) opens them. This registry only exists to
 * publish them in `GET /api/docs/openapi.json` (lib/openapi-aggregator.ts).
 *
 * No dependencies on purpose: the routes and the aggregator import it.
 */
import type { KonOperation } from "@kitsuden/shared";

export interface CoreOperations {
  konId: string;
  mountPath: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each operation brings its own schemas
  operations: KonOperation<any, any, any>[];
}

const registry = new Map<string, CoreOperations>();

export function registerCoreOperations(e: CoreOperations): void {
  registry.set(e.konId, e);
}

export function coreOperations(): CoreOperations[] {
  return [...registry.values()];
}
