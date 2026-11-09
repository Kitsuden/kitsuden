/**
 * Kitsuden — Request Validation (re-export from @kitsuden/engine)
 *
 * The implementation lives in packages/engine so that kons (plugins)
 * validate requests with the same envelope. Compatibility shim.
 */
export { validateRequest, validated, parseOrThrow, type ValidationTarget } from "@kitsuden/engine";
