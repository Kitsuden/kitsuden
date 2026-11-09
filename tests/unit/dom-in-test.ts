/**
 * jsdom mounted FROM the test, not with `// @vitest-environment jsdom`.
 *
 * With the comment, vitest loads jsdom when the worker STARTS, and that startup
 * has a fixed limit of 60 s (`START_TIMEOUT` in vitest 4, not configurable).
 * jsdom drags in hundreds of files: measured on Windows, 2.8 s warm
 * and 27 s cold; with the whole suite competing for disk and CPU it
 * went past the minute and the file died with "Timeout waiting for worker to
 * respond" without running a single test (and without any test failing: the
 * suite just counted one error).
 *
 * Here the SAME environment is mounted (`builtinEnvironments.jsdom` from vitest,
 * the one the comment uses) during the file's import, which has no such
 * limit: the worker starts in the node environment instantly and jsdom loads
 * for however long it takes.
 */
import { afterAll } from "vitest";
import { builtinEnvironments } from "vitest/environments";

export async function mountJsdom(): Promise<void> {
  const environment = await builtinEnvironments.jsdom.setup(globalThis, {});
  afterAll(async () => {
    await environment.teardown(globalThis);
  });
}
