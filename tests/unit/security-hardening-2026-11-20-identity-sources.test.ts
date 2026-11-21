/**
 * Identity and agent-management hardening that needs a database or better-auth
 * to run end to end, pinned on the source (hardening 2026-11-20):
 *
 *   · no account through better-auth while there is no admin (a social
 *     sign-in callback creates the user itself, past the sign-up gate);
 *   · regenerating an agent's token revokes its earlier static keys;
 *   · agent edits and deletions over REST leave an audit entry;
 *   · the llms.txt guide, built from the request's Host, varies on it;
 *   · the public theme-config route does not return the error message.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("first run: better-auth creates no user while there is no admin", () => {
  it("auth.ts has a user.create.before hook that refuses on firstRunRefuses()", () => {
    const src = read("apps/api/src/lib/auth.ts");
    const hooks = src.slice(
      src.indexOf("databaseHooks:"),
      src.indexOf("session: {", src.indexOf("databaseHooks:"))
    );
    expect(hooks).toMatch(/user:\s*\{\s*create:\s*\{\s*before:/);
    expect(hooks).toMatch(/if \(await firstRunRefuses\(\)\) return false;/);
  });
});

describe("agent management", () => {
  const v1 = read("apps/api/src/routes/agents-v1.ts");
  const legacy = read("apps/api/src/routes/agents.ts");

  it("POST /api/v1/agents/:id/token revokes the agent's other live static keys", () => {
    const route = v1.slice(v1.indexOf('.post("/agents/:id/token"'), v1.indexOf("// TRACES"));
    expect(route).toContain("db.transaction");
    expect(route).toMatch(/\.set\(\{ revokedAt: new Date\(\), revokedBy: by \}\)/);
    expect(route).toMatch(/isNull\(agentApiKeys\.revokedAt\)/);
    expect(route).toMatch(/ne\(agentApiKeys\.algorithm, "oauth"\)/);
  });

  it("every update and delete route writes an audit entry", () => {
    for (const [src, marks] of [
      [legacy, ['agentsRouter.put("/:id"', 'agentsRouter.delete("/:id"']],
      [v1, ['.patch("/agents/:id"', '.delete("/agents/:id"', '.delete("/identities/:id"']],
    ] as const) {
      for (const mark of marks) {
        const start = src.indexOf(mark);
        expect(start, mark).toBeGreaterThan(-1);
        const body = src.slice(start, src.indexOf("logger.error", start));
        expect(body, mark).toContain("logAgentAction(");
      }
    }
  });
});

describe("web surface", () => {
  it("the llms.txt guide varies on Host", () => {
    expect(read("apps/api/src/lib/agent-guide.ts")).toMatch(/vary: "Origin, Host"/);
  });

  it("the public theme-config route answers a 500 without the error message", () => {
    const src = read("apps/api/src/routes/system.ts");
    expect(src).not.toContain("messageOf(err)");
  });
});
