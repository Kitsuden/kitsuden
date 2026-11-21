/**
 * Kon rules (2026-11-20).
 *
 *   - H65: a kon's rules are the rows whose slug starts with `<kon id>--`. A kon
 *     id that itself held `--` (`kon-crm--x`) or ended in `-` shared that prefix
 *     with another kon: it could overwrite kon-crm's rule `x--y` and kon-crm's
 *     `listRules` listed its rules. Such ids are refused.
 *   - H67: a kon handler's `validate` ran on the stored config, placeholders and
 *     all; the config filled from the event went to `run` unchecked. It is now
 *     validated again, and a refused step fails without running.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({
  db: {
    select: () => {
      throw new Error("no database in this test");
    },
  },
}));

import { konAutomation } from "../../apps/api/src/lib/actions/kon-automation";
import { executeRuleAction } from "../../apps/api/src/lib/actions/rules";
import {
  forgetKonContributions,
  registerKonContributions,
} from "../../apps/api/src/lib/kon-contributions";

describe("H65: a kon id names one slug prefix", () => {
  it.each(["kon-crm--x", "kon-crm-", "-kon", "kon--crm", ""])("refuses %j", async (id) => {
    await expect(konAutomation.listRules(id)).rejects.toThrow(/kon id is required/);
    await expect(konAutomation.removeRule(id, "x")).rejects.toThrow(/kon id is required/);
  });

  it("accepts an ordinary kon id (and goes on to check the rule)", async () => {
    await expect(
      konAutomation.upsertRule("kon-crm", { slug: "Bad Slug" } as never)
    ).rejects.toThrow(/slug must be/);
  });
});

describe("H67: a kon handler validates the config filled from the event", () => {
  const run = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    run.mockClear();
    forgetKonContributions("kon-tag");
    registerKonContributions(
      {
        id: "kon-tag",
        actionHandlers: [
          {
            id: "paint",
            label: "Paint",
            validate: (c: Record<string, unknown>) =>
              typeof c.color === "string" &&
              (/^#[0-9a-f]{6}$/.test(c.color) || c.color.includes("{{"))
                ? null
                : "color must be #rrggbb",
            run,
          },
        ],
      } as never,
      {} as never
    );
  });

  const rule = {
    id: "rule-1",
    name: "Paint",
    type: "rule",
    createdById: null,
    config: { steps: [{ handler: "kon-tag:paint", config: { color: "{{event.color}}" } }] },
  } as never;
  const withColor = (color: unknown) =>
    ({ executionId: "e", event: { name: "tag:item.created", data: { color } } }) as never;

  it("runs when the filled config is valid", async () => {
    const result = await executeRuleAction(rule, withColor("#00ff00"));
    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses the step, without running it, when the event fills in what validate rejects", async () => {
    const result = await executeRuleAction(rule, withColor("red; DROP TABLE"));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/config filled from the event is refused: color must be/);
    expect(run).not.toHaveBeenCalled();
  });
});
