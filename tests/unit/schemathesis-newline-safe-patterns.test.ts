/**
 * The Schemathesis spec ends its `$` anchors in `(?!\n)` (apps/api/scripts/lib/newline-safe-patterns.ts)
 * ============================================================================
 *
 *   · every `$` anchor gets it (end, before `|`, before `)`), once, and nothing else changes:
 *     an escaped `\$`, a `$` inside a character class, a `$` followed by more pattern;
 *   · the result accepts and rejects exactly what the original did in JavaScript, and
 *     no longer accepts a final "\n" read the Python way (what Hypothesis did);
 *   · the walk rewrites `pattern` and `patternProperties` keys everywhere in the document,
 *     including fields named `default` or `enum`, and leaves defaults and examples alone.
 */

import { describe, expect, it } from "vitest";

import {
  newlineSafePattern,
  newlineSafeSpec,
} from "../../apps/api/scripts/lib/newline-safe-patterns";

describe("newlineSafePattern", () => {
  it.each([
    ["^[0-9]{1,15}(\\.[0-9]{1,4})?$", "^[0-9]{1,15}(\\.[0-9]{1,4})?$(?!\\n)"],
    ["^[A-Z]{3}$", "^[A-Z]{3}$(?!\\n)"],
    ["^a$|^b$", "^a$(?!\\n)|^b$(?!\\n)"],
    ["^(?:a$|b$)", "^(?:a$(?!\\n)|b$(?!\\n))"],
    ["^(a|b)$", "^(a|b)$(?!\\n)"],
  ])("anchors %s", (before, after) => {
    expect(newlineSafePattern(before)).toBe(after);
  });

  it.each([
    "^price\\$", // an escaped dollar sign is a literal one
    "^[$€]+", // inside a class
    "^[\\]$]+", // inside a class that holds an escaped `]`
    "^[]$]", // `]` right after `[` is literal in the class syntax this handles
    "^a$b", // followed by more pattern: not the end
    "^\\\\\\$", // `\\` then `\$`: still a literal dollar
    "^[A-Za-z0-9_.:-]+", // no anchor at all
    "^a$(?!\\n)", // already done
  ])("leaves %s as it is", (pattern) => {
    expect(newlineSafePattern(pattern)).toBe(pattern);
  });

  it("does nothing twice", () => {
    const once = newlineSafePattern("^a$|^(b$)");
    expect(newlineSafePattern(once)).toBe(once);
  });

  it("matches the same strings in JavaScript, and refuses a final newline", () => {
    const samples = ["12", "12.5", "12.55555", "", "x", "12\n", "12.5\n", "\n12", "1 2"];
    for (const source of ["^[0-9]{1,15}(\\.[0-9]{1,4})?$", "^a$|^b$", "^(a|bc)$"]) {
      const before = new RegExp(source);
      const after = new RegExp(newlineSafePattern(source));
      for (const s of [...samples, "a", "b", "bc", "a\n", "bc\n"]) {
        expect(after.test(s), `${source} on ${JSON.stringify(s)}`).toBe(before.test(s));
      }
    }
    // What Hypothesis did: a Python `$` lets "12\n" through; `$(?!\n)` does not, read either way.
    // (JavaScript's `m` flag is the closest stand-in for "also before a final newline".)
    expect(/^12$/m.test("12\n")).toBe(true);
    expect(/^12$(?!\n)/m.test("12\n")).toBe(false);
  });
});

describe("newlineSafeSpec", () => {
  const doc = {
    paths: {
      "/x": {
        post: {
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              schema: { type: "string", pattern: "^[a-z]+$" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    lines: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          amount: { type: "string", pattern: "^[0-9]+$", default: "0" },
                        },
                      },
                    },
                    default: { type: "string", pattern: "^d$" },
                    enum: { type: "string", pattern: "^e$" },
                    pattern: { type: "string", pattern: "^p$" },
                  },
                  patternProperties: { "^x-[a-z]+$": { type: "string", pattern: "^v$" } },
                  example: { pattern: "^keep$" },
                  default: { pattern: "^keep$" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { Code: { type: "string", pattern: "^[A-Z]{3}$", examples: ["^keep$"] } },
    },
  };

  it("rewrites every pattern and patternProperties key, and counts them", () => {
    const changed = { count: 0 };
    const out = newlineSafeSpec(doc, changed) as typeof doc;
    const body = out.paths["/x"].post.requestBody.content["application/json"].schema;
    expect(out.paths["/x"].post.parameters[0]!.schema.pattern).toBe("^[a-z]+$(?!\\n)");
    expect(body.properties.lines.items.properties.amount.pattern).toBe("^[0-9]+$(?!\\n)");
    expect(body.properties.default.pattern).toBe("^d$(?!\\n)");
    expect(body.properties.enum.pattern).toBe("^e$(?!\\n)");
    expect(body.properties.pattern.pattern).toBe("^p$(?!\\n)");
    expect(Object.keys(body.patternProperties)).toEqual(["^x-[a-z]+$(?!\\n)"]);
    expect(Object.values(body.patternProperties)[0]!.pattern).toBe("^v$(?!\\n)");
    expect(out.components.schemas.Code.pattern).toBe("^[A-Z]{3}$(?!\\n)");
    expect(changed.count).toBe(8);
  });

  it("leaves defaults, examples and the input alone", () => {
    const before = JSON.stringify(doc);
    const out = newlineSafeSpec(doc) as typeof doc;
    const body = out.paths["/x"].post.requestBody.content["application/json"].schema;
    expect(body.example).toEqual({ pattern: "^keep$" });
    expect(body.default).toEqual({ pattern: "^keep$" });
    expect(body.properties.lines.items.properties.amount.default).toBe("0");
    expect(out.components.schemas.Code.examples).toEqual(["^keep$"]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
