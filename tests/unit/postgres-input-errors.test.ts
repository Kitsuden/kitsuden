/**
 * An input that Postgres does not accept is NOT a 500
 *
 * Schemathesis found a dozen 500s that were this: text
 * with U+0000 (Postgres stores it neither in `text` nor in `jsonb`), a `0` where
 * a uuid goes, an out-of-range number, a duplicate. Two layers close it:
 *
 *   · the SDK rejects U+0000 in the input, before the handler;
 *   · `toErrorEnvelope` translates the SQLSTATE of an error that escapes.
 */
import { describe, expect, it } from "vitest";

import { postgresInputError, sqlstateOf, toErrorEnvelope } from "../../packages/engine/src/errors";
import { pathWithNullCharacter } from "../../packages/engine/src/operations";

/** What Drizzle throws: «Failed query: …» with the `pg` error in `cause`. */
function fromDrizzle(code: string): Error {
  const pg = Object.assign(new Error('invalid input syntax for type uuid: "0"'), { code });
  return Object.assign(
    new Error('Failed query: select "slug" from "block_pages" where "id" = $1'),
    { cause: pg }
  );
}

describe("translating Postgres errors", () => {
  it("finds the SQLSTATE inside the cause chain", () => {
    expect(sqlstateOf(fromDrizzle("22P02"))).toBe("22P02");
    expect(sqlstateOf(new Error("something else"))).toBeNull();
  });

  it("class 22 → 400; duplicate or broken reference → 409; required → 422", () => {
    expect(postgresInputError(fromDrizzle("22P02"))?.status).toBe(400); // invalid uuid
    expect(postgresInputError(fromDrizzle("22021"))?.status).toBe(400); // U+0000 in text
    expect(postgresInputError(fromDrizzle("22003"))?.status).toBe(400); // out of range
    expect(postgresInputError(fromDrizzle("23505"))?.status).toBe(409);
    expect(postgresInputError(fromDrizzle("23503"))?.status).toBe(409);
    expect(postgresInputError(fromDrizzle("23502"))?.status).toBe(422);
    // What is truly the server's (connection, permissions) stays untranslated.
    expect(postgresInputError(fromDrizzle("08006"))).toBeNull();
    expect(postgresInputError(fromDrizzle("42501"))).toBeNull();
  });

  it("the envelope does not show the query", () => {
    const { status, envelope } = toErrorEnvelope(fromDrizzle("22P02"), { isDev: true });
    expect(status).toBe(400);
    expect(envelope.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(envelope)).not.toMatch(/Failed query|block_pages|select/i);
  });

  it("any other error is still a 500", () => {
    expect(toErrorEnvelope(new Error("boom"), {}).status).toBe(500);
  });
});

describe("the null character is rejected in the input", () => {
  it("finds it in values and in keys, at any depth", () => {
    expect(pathWithNullCharacter({ title: "ok" })).toBeNull();
    expect(pathWithNullCharacter({ title: "a\u0000b" })).toBe("title");
    expect(pathWithNullCharacter({ data: { list: ["x", "y\u0000"] } })).toBe("data.list.1");
    expect(pathWithNullCharacter({ data: { "cla\u0000ve": 1 } })).toBe("data.cla\u0000ve");
    expect(pathWithNullCharacter("stray\u0000")).toBe("_");
    expect(pathWithNullCharacter(null)).toBeNull();
  });
});
