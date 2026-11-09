/**
 * Kitsuden — Error Envelope (re-export from @kitsuden/engine)
 *
 * The implementation lives in packages/engine so that BOTH the app AND the
 * kons (plugins) use the same envelope. This shim keeps the existing
 * imports (`../lib/errors`) working.
 */
export {
  AppError,
  ErrorCode,
  toErrorEnvelope,
  respondError,
  type ErrorCodeValue,
  type ErrorEnvelope,
} from "@kitsuden/engine";
