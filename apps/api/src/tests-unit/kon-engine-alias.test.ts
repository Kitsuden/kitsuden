/**
 * A kon's `@kitsuden/engine` is the process's engine (lib/kon-engine-alias.ts).
 *
 * In the production bundle the kons used to get a second copy of the engine from
 * sources: their queue handlers never ran and their `asSystem()` did nothing. This
 * checks that, once registered, the specifier a kon imports gives back the very
 * functions this process uses, queue included.
 */
import { describe, expect, it } from "bun:test";

import * as engine from "../../../../packages/engine/index";
import { shareEngineWithKons } from "../lib/kon-engine-alias";

describe("kon engine alias", () => {
  it("registers once and is idempotent", () => {
    expect(shareEngineWithKons()).toBe(true);
    expect(shareEngineWithKons()).toBe(true);
  });

  it("a kon's import of @kitsuden/engine returns this process's functions", async () => {
    shareEngineWithKons();
    const specifier = "@kitsuden/engine";
    const fromKon = (await import(specifier)) as Record<string, unknown>;
    for (const name of [
      "asSystem",
      "withSavepoint",
      "repo",
      "queue",
      "useRequest",
      "definePolicy",
    ]) {
      expect(name in engine).toBe(true);
      expect(fromKon[name]).toBe((engine as Record<string, unknown>)[name]);
    }
  });
});
