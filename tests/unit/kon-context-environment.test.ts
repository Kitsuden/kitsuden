/**
 * The environment kons receive
 * ============================================================================
 *
 * `createKonContext()` builds what the 29 kons receive. Its field
 * `config.environment` is declared as `"development" | "production" |
 * "test"`, but it was filled with `(process.env.NODE_ENV as any) || "development"`.
 *
 * That `as any` was not a typing oversight: it let ANY environment value
 * through. With `NODE_ENV=staging` —a perfectly normal value in
 * many deployments— every kon that did `if (env === "production")` decided
 * it was not, and every one that did `if (env === "development")` decided the same. The
 * kon ended up in a third branch nobody wrote.
 *
 * Now it is narrowed: whatever is not `production` or `test` is `development`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createKonContext } from "../../apps/api/src/lib/module-loader";

const original = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = original;
});

describe("KonContext environment", () => {
  it("recognizes the three declared values", () => {
    for (const value of ["production", "test", "development"] as const) {
      process.env.NODE_ENV = value;
      expect(createKonContext().config.environment).toBe(value);
    }
  });

  it("an unknown NODE_ENV falls to development, it does not slip through as is", () => {
    // This used to return "staging", a value the type does not allow and that
    // no kon's comparison covers.
    process.env.NODE_ENV = "staging";
    expect(createKonContext().config.environment).toBe("development");
  });

  it("without NODE_ENV it also falls to development", () => {
    delete process.env.NODE_ENV;
    expect(createKonContext().config.environment).toBe("development");
  });

  it("the context brings the content-publishing registry already mounted", () => {
    // It is built with a deferred reference to the context itself (chicken
    // and egg). If that part breaks, the kon receives an `undefined` and fails when
    // registering its target, far from here.
    const ctx = createKonContext();
    expect(typeof ctx.contentPublishing.register).toBe("function");
    expect(ctx.contentPublishing.getAvailableTargets()).toEqual([]);
  });
});
