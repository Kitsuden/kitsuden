/**
 * Inti's write actions (INTI=true only)
 * ============================================================================
 *
 * Not in `src/actions/index.ts` on purpose: Astro mounts `/_actions/*` in
 * every build when that file exists, and this one imports Inti.
 * astro.config.mjs points the actions entry here and mounts the route only
 * with INTI=true.
 *
 * Who may write is decided by the plugin of `./editor-session.ts`; the key
 * the adapter writes with (`INTI_KITSUDEN_TOKEN`) is read from `process.env`
 * when the server starts and never leaves it.
 */
import { intiActions } from "@intijs/core/actions";

export const server = { inti: intiActions };
