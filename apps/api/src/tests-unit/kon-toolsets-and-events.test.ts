/**
 * Kon tool groups, narrowing a run, and kon events — no database
 * ============================================================================
 *
 * lib/mcp-settings.ts (`kon:<id>/<set>`), services/agent-narrowing.ts (what a kon may do to an agent's tools)
 * and lib/events.ts (`onAny`, which lets actions hear a kon's own events).
 */

import { describe, expect, it } from "bun:test";

import { events } from "../lib/events";
import {
  inToolset,
  konToolsetNames,
  parseToolset,
  registerKonToolsets,
  toolsetText,
} from "../lib/mcp-settings";
import { NO_TOOLS, approvalOf, narrowTools } from "../services/agent-narrowing";

registerKonToolsets("kon-crm", {
  sales: ["list-deals", "move-deal"],
  research: ["record-observation"],
  empty: [],
});

const card = (name: string, readOnly = false) => {
  const i = name.indexOf("__");
  return {
    name,
    source: (i > 0 ? "kon" : "core") as "kon" | "core",
    kon: i > 0 ? name.slice(0, i) : null,
    readOnly,
  };
};
const tool = (name: string) => ({ function: { name } });

describe("a kon's own tool groups", () => {
  it("kon:crm/sales holds exactly the operations the kon declared", () => {
    const parsed = parseToolset("kon:crm/sales");
    if (!parsed.ok) throw new Error(parsed.error);
    const names = [
      "crm__list-deals",
      "crm__move-deal",
      "crm__delete-deal",
      "blog__list-deals",
      "kitsuden_query_dataset",
    ];
    expect(names.filter((n) => inToolset(parsed.toolset, card(n)))).toEqual([
      "crm__list-deals",
      "crm__move-deal",
    ]);
    expect(toolsetText(parsed.toolset)).toBe("kon:crm/sales");
  });

  it("a set the kon does not declare is a 400, naming the ones it does; an empty set is dropped", () => {
    const r = parseToolset("kon:crm/everything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("sales, research");
    expect(konToolsetNames("crm")).toEqual(["sales", "research"]);
  });

  it("combines with the rest as a union, and kon-crm and crm are the same kon", () => {
    const parsed = parseToolset("read, kon:kon-crm/research");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(inToolset(parsed.toolset, card("crm__record-observation"))).toBe(true);
    expect(inToolset(parsed.toolset, card("crm__move-deal"))).toBe(false);
    expect(inToolset(parsed.toolset, card("crm__get-deal", true))).toBe(true);
  });
});

describe("narrowing a run", () => {
  const all = [
    "crm__list-deals",
    "crm__move-deal",
    "crm__delete-deal",
    "kitsuden_create_record",
  ].map(tool);

  it("without narrowing, the agent keeps its own list (empty means all)", () => {
    expect(narrowTools(all, [], {})).toEqual({ tools: all, allowedTools: [] });
  });

  it("never widens past the agent's own list", () => {
    const r = narrowTools(all, ["crm__list-deals"], {
      allowedTools: ["crm__list-deals", "crm__delete-deal"],
    });
    expect(r.allowedTools).toEqual(["crm__list-deals"]);
  });

  it("a toolset narrows to the kon's group, and only kon toolsets are accepted", () => {
    expect(narrowTools(all, [], { toolset: "kon:crm/sales" }).allowedTools).toEqual([
      "crm__list-deals",
      "crm__move-deal",
    ]);
    expect(() => narrowTools(all, [], { toolset: "core" })).toThrow(/only with kon/);
  });

  it("nothing left means nothing allowed, not everything", () => {
    const r = narrowTools(all, [], { allowedTools: ["blog__nope"] });
    expect(r).toEqual({ tools: [], allowedTools: [NO_TOOLS] });
  });
});

describe("kon events reach whoever listens to any event", () => {
  it("onAny hears a kon's event, and a listener that throws does not break the emitter", () => {
    const heard: unknown[] = [];
    events.onAny(() => {
      throw new Error("boom");
    });
    events.onAny((name, data) => {
      if (name === "crm:deal:stage-changed") heard.push(data);
    });
    expect(() => events.emit("crm:deal:stage-changed", { dealId: "d1" })).not.toThrow();
    expect(heard).toEqual([{ dealId: "d1" }]);
  });
});

describe("a tool held for a person", () => {
  it("is told apart from a result, with its proposal id", () => {
    const held = `Pending human approval: stored as proposal p_123. It has NOT been executed. Do not call the tool again.
${JSON.stringify({ code: "KITSUDEN_E_APPROVAL_REQUIRED", status: 202, proposal: { id: "p_123", status: "pending" } })}`;
    expect(approvalOf(held)).toEqual({ proposalId: "p_123" });
    expect(
      approvalOf(
        JSON.stringify({
          code: "KITSUDEN_E_APPROVAL_REQUIRED",
          proposal: { status: "pending", id: "p_9" },
        })
      )
    ).toEqual({ proposalId: "p_9" });
    expect(approvalOf('{"data":[{"id":"x"}]}')).toBeUndefined();
  });
});
