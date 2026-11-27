/**
 * Two copies of the engine share the request
 * ============================================================================
 *
 * In production the API runs bundled (`dist/index.js`, with its own copy of the
 * engine) and the kons import `@kitsuden/engine` from sources: two copies in one
 * process. Each kept the request state (AsyncLocalStorage, the RLS context per
 * transaction) in module variables, so a kon's `asSystem()` did not see the
 * transaction the core had opened. `PUT /api/builder/definitions` answered 500:
 * the history INSERT ran with the user's context, RLS refused it and, with no
 * savepoint, the whole request was undone (2026-11-27). The tests load the sources
 * once, so they never saw it.
 *
 * `vi.resetModules()` gives a second, independent copy of the same files, as the
 * bundle and the kon have in production.
 */
import { describe, expect, it, vi } from "vitest";

type Engine = typeof import("../../packages/engine/src/rls-request") &
  typeof import("../../packages/engine/src/request-scope");

async function loadCopy(): Promise<Engine> {
  vi.resetModules();
  const rls = await import("../../packages/engine/src/rls-request");
  const scope = await import("../../packages/engine/src/request-scope");
  return { ...rls, ...scope };
}

/** A transaction that only records the `set_config` values it receives. */
function fakeTx() {
  const contexts: string[] = [];
  const tx = {
    async execute(query: { queryChunks?: unknown[] }) {
      const values = (query.queryChunks ?? []).filter((c): c is string => typeof c === "string");
      contexts.push(values.join("|"));
      return { rows: [] };
    },
    async transaction<T>(fn: (sp: unknown) => Promise<T>) {
      return fn(tx);
    },
  };
  return { tx, contexts };
}

describe("two copies of the engine in one process", () => {
  it("are really two copies (the test means something)", async () => {
    const core = await loadCopy();
    const kon = await loadCopy();
    expect(kon.asSystem).not.toBe(core.asSystem);
    expect(kon.useRequest).not.toBe(core.useRequest);
  });

  it("the kon's copy sees the request the core's copy opened", async () => {
    const core = await loadCopy();
    const kon = await loadCopy();
    await core.runInRequestScope({ requestId: "req-1" }, async () => {
      expect(kon.useRequest()?.requestId).toBe("req-1");
    });
  });

  it("the kon's asSystem switches to the system inside the core's transaction", async () => {
    const core = await loadCopy();
    const kon = await loadCopy();
    const { tx, contexts } = fakeTx();

    await core.runInRequestScope({ requestId: "req-2" }, async () => {
      await core.setRlsContext(tx as never, { id: "user-1", role: "agent" });
      core.setRequestTx(tx);
      contexts.length = 0;

      let ranAs = "";
      await kon.asSystem(async () => {
        ranAs = contexts.at(-1) ?? "(no switch)";
      });

      // Inside: the system (empty id and role); after: the agent again
      expect(ranAs).not.toContain("user-1");
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      expect(contexts.at(-1)).toContain("user-1");
    });
  });
});
