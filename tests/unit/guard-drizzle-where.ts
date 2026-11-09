/**
 * RUNTIME guard: `.where()` twice on the same builder
 * ============================================================================
 *
 * `tests/unit/drizzle-chained-where.test.ts` looks for the shape of the defect in
 * the TEXT. It works, but it is a net with known holes: it does not see an
 * accumulation split across functions (`q = applyFilter(q, cond)`), nor a
 * builder stored in a field, nor anything that does not fit its regular expression.
 *
 * This is the other half: Drizzle's builders are patched so that the SECOND
 * call to `.where()` on the same instance THROWS. How it was written no longer
 * matters; what happens does. A helper, a loop or three files of
 * distance make no difference.
 *
 * ── WHAT THIS DOES NOT PROVE ────────────────────────────────────────────────
 *
 * It only fires on the paths the tests EXECUTE. It does not make the static
 * guard redundant: one covers all the code without running it and
 * with holes in shape; the other covers without holes in shape but only what
 * is executed. Both are needed, and the second one's limit is coverage.
 *
 * ── WHY THROWING BREAKS NOTHING LEGITIMATE ──────────────────────────────────
 *
 * Because in Drizzle there is no legitimate use: the second call replaces the
 * condition of the first. Whoever does it on purpose is already wrong. If
 * this ever fires on correct code, the correct code is what to
 * look at first.
 */

import {
  PgDeleteBase,
  PgSelectBase,
  PgSelectQueryBuilderBase,
  PgUpdateBase,
} from "drizzle-orm/pg-core";

/** Instances that already received a `.where()`. Weak: it does not retain builders. */
const alreadyFiltered = new WeakSet<object>();

export class DoubleWhereError extends Error {
  constructor(operation: string) {
    super(
      `${operation}: second call to .where() on the SAME builder. In Drizzle ` +
        `that does not add the condition, it REPLACES the previous one — the query ends up ` +
        `filtering only by the last one and returns (or writes) too much, with no error. ` +
        `Accumulate in an array and call .where(and(...conditions)) just once. ` +
        `If the filter is built across several functions, pass the CONDITIONS around, ` +
        `not the builder.`
    );
    this.name = "DoubleWhereError";
  }
}

/** Wraps a prototype's `where` so the second call throws. */
function watch(kind: { prototype: Record<string, unknown> } | undefined, tag: string): void {
  const proto = kind?.prototype;
  if (!proto || typeof proto.where !== "function") return;
  // Idempotent: test files are loaded several times per process.
  if ((proto.where as { __watched?: boolean }).__watched) return;

  const original = proto.where as (...args: unknown[]) => unknown;

  function watched(this: object, ...args: unknown[]): unknown {
    if (alreadyFiltered.has(this)) throw new DoubleWhereError(tag);
    alreadyFiltered.add(this);
    return original.apply(this, args);
  }
  (watched as { __watched?: boolean }).__watched = true;

  proto.where = watched;
}

export function installWhereGuard(): void {
  watch(PgSelectBase as never, "SELECT");
  watch(PgSelectQueryBuilderBase as never, "Dynamic SELECT");
  watch(PgUpdateBase as never, "UPDATE");
  watch(PgDeleteBase as never, "DELETE");
}
