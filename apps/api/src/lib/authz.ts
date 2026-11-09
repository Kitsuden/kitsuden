/**
 * Kitsuden — Authorization: Policies & Gates (re-export from @kitsuden/engine)
 *
 * The implementation lives in packages/engine so that kons (plugins)
 * can define and evaluate their own policies. Compatibility shim.
 */
export {
  definePolicy,
  defineGate,
  can,
  authorize,
  policyMap,
  resetAuthz,
  requireGate,
  requirePolicy,
  type AuthzUser,
  type PolicyRule,
  type GateRule,
} from "@kitsuden/engine";
