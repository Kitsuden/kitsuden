/**
 * The record history's diff (packages/engine/src/record-history.ts): only changed
 * fields, secret columns redacted without values, bounded sizes, the actor.
 */
import { describe, expect, it } from "vitest";

import {
  RECORD_HISTORY_LIMITS,
  actorOf,
  diffRecord,
} from "../../packages/engine/src/record-history";

describe("diffRecord", () => {
  it("lists only what changed, flattening an entry's data", () => {
    const { changes, truncated } = diffRecord(
      { id: "1", title: "A", data: { price: 1, color: "red", _schemaVersion: 1 }, updatedAt: "x" },
      { id: "1", title: "A", data: { price: 2, size: "L" }, updatedAt: "y" },
      { nested: "data", skip: ["id"] }
    );
    expect(truncated).toBe(false);
    expect(changes).toEqual([
      { field: "data.price", before: 1, after: 2 },
      { field: "data.color", before: "red", after: null },
      { field: "data.size", before: null, after: "L" },
    ]);
  });

  it("a create lists the values set; a delete the values removed", () => {
    expect(diffRecord(null, { name: "x", note: null }).changes).toEqual([
      { field: "name", after: "x" },
    ]);
    expect(diffRecord({ name: "x" }, null).changes).toEqual([{ field: "name", before: "x" }]);
  });

  it("never keeps the value of a secret column, nor secret keys inside JSON", () => {
    const { changes } = diffRecord(
      { api_token: "a", password_hash: "h", settings: { theme: "dark", clientSecret: "s1" } },
      { api_token: "b", password_hash: "h2", settings: { theme: "light", clientSecret: "s2" } }
    );
    expect(changes).toContainEqual({ field: "api_token", redacted: true });
    expect(changes).toContainEqual({ field: "password_hash", redacted: true });
    expect(changes).toContainEqual({
      field: "settings",
      before: { theme: "dark" },
      after: { theme: "light" },
    });
    expect(JSON.stringify(changes)).not.toMatch(/"a"|"b"|h2|s1|s2/);
  });

  it("a secret that changed only inside JSON does not count as a change", () => {
    expect(diffRecord({ cfg: { token: "1" } }, { cfg: { token: "2" } }).changes).toEqual([]);
  });

  it("cuts long values and too many fields", () => {
    const long = "x".repeat(RECORD_HISTORY_LIMITS.valueChars + 10);
    const one = diffRecord({ body: "" }, { body: long });
    expect(one.truncated).toBe(true);
    expect(one.changes[0]!.after).toMatchObject({ truncated: true });

    const many = Object.fromEntries(
      Array.from({ length: RECORD_HISTORY_LIMITS.fields + 5 }, (_, i) => [`f${i}`, i])
    );
    const wide = diffRecord({}, many);
    expect(wide.truncated).toBe(true);
    expect(wide.changes).toHaveLength(RECORD_HISTORY_LIMITS.fields);
  });

  it("keeps the whole list under its size limit", () => {
    const big = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`f${i}`, "y".repeat(1900)])
    );
    const { changes, truncated } = diffRecord({}, big);
    expect(truncated).toBe(true);
    expect(JSON.stringify(changes).length).toBeLessThanOrEqual(RECORD_HISTORY_LIMITS.changeChars);
  });
});

describe("actorOf", () => {
  it("tells a person from an agent and from the system", () => {
    expect(actorOf({ id: "u1", name: "Ana", role: "editor" })).toEqual({
      type: "user",
      id: "u1",
      name: "Ana",
    });
    expect(actorOf({ id: "ag", name: "Bot", role: "agent" })).toMatchObject({ type: "agent" });
    expect(actorOf(null)).toEqual({ type: "system", id: null, name: null });
  });
});
