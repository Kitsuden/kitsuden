/**
 * Per-request RLS: BEGIN + context in a single round trip, without injection
 * ============================================================================
 *
 * Performance: the lazy transaction held `begin` and the context's
 * `set_config` calls and sent them one by one (2–3 trips to Postgres
 * before the first query). Now they go together in one simple query with
 * the values as literals escaped by the driver. This checks:
 *   · that only the known shapes are joined (another statement → one by one);
 *   · that a value with quotes, backslashes or `;` stays INSIDE the literal;
 *   · that without `escapeLiteral` (another driver) nothing is joined.
 */

import pg from "pg";
import { describe, expect, it } from "vitest";

import { deferredInOneStatement } from "../../packages/engine/src/rls-request";

// node-postgres's real `escapeLiteral` (needs no connection)
const client = { escapeLiteral: pg.Client.prototype.escapeLiteral };

const CONTEXT =
  "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)";
const SCOPES = "SELECT set_config('app.agent_scopes', $1, true)";

describe("deferredInOneStatement", () => {
  it("joins begin + context (Drizzle's shape: object with text and values)", () => {
    const together = deferredInOneStatement(
      [[{ text: "begin", values: [] }], [{ text: CONTEXT, values: ["u-1", "admin"] }]],
      client
    );
    expect(together).toBe(
      "begin; SELECT set_config('app.current_user_id', 'u-1', true), set_config('app.current_user_role', 'admin', true)"
    );
  });

  it("real Drizzle node-postgres shape: query({ name, text, types }, params)", () => {
    const types = { getTypeParser: () => (v: unknown) => v };
    const together = deferredInOneStatement(
      [
        [{ name: undefined, text: "begin", types }, []],
        [{ name: undefined, text: CONTEXT, types }, ["", "anonymous"]],
      ],
      client
    );
    expect(together).toBe(
      "begin; SELECT set_config('app.current_user_id', '', true), set_config('app.current_user_role', 'anonymous', true)"
    );
  });

  it("also joins the agent's scopes", () => {
    const together = deferredInOneStatement(
      [["begin"], [CONTEXT, ["a-1", "agent"]], [SCOPES, ["mcp:read,datasets:*:read"]]],
      client
    );
    expect(together).toContain("set_config('app.agent_scopes', 'mcp:read,datasets:*:read', true)");
    expect(together?.split("; ")).toHaveLength(3);
  });

  it("a hostile value stays inside the literal", () => {
    const hostile = "x', true); DROP TABLE data_entries; --\\";
    const together = deferredInOneStatement([["begin"], [CONTEXT, [hostile, "user"]]], client);
    // escapeLiteral doubles the quote and, with a backslash, uses E'...' with the backslash doubled
    expect(together).toContain(`E'x'', true); DROP TABLE data_entries; --\\\\'`);
    // Outside the literals only the two expected statements remain
    // (escapeLiteral puts « E'…'» with a space in front when there are backslashes)
    const withoutLiterals = together!.replace(/E?'(?:[^']|'')*'/g, "''").replace(/\s+/g, " ");
    expect(withoutLiterals).toBe(
      "begin; SELECT set_config('', '', true), set_config('', '', true)"
    );
  });

  it("any other statement, non-text values or another driver → one by one (null)", () => {
    expect(
      deferredInOneStatement([["begin"], ["select * from users where id = $1", ["x"]]], client)
    ).toBeNull();
    expect(
      deferredInOneStatement(
        [["begin isolation level serializable"], [CONTEXT, ["a", "b"]]],
        client
      )
    ).toBeNull();
    expect(deferredInOneStatement([["begin"], [CONTEXT, ["a", 7]]], client)).toBeNull();
    expect(deferredInOneStatement([["begin"], [CONTEXT, ["a"]]], client)).toBeNull();
    expect(deferredInOneStatement([["begin"], [CONTEXT, ["a", "b"]]], {})).toBeNull();
    expect(
      deferredInOneStatement([[{ text: "begin", rowMode: "array" }], [CONTEXT, ["a", "b"]]], client)
    ).toBeNull();
    expect(deferredInOneStatement([["begin"]], client)).toBeNull();
  });
});
