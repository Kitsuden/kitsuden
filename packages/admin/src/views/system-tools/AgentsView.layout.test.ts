/**
 * The agent card's trash button stays inside the card
 * ============================================================================
 *
 * In the three-column grid the card is ~200 px of usable width, and the
 * "Playground" + "Configure" + `flex-1` spacer + trash row could not
 * wrap: the trash button spilled out the right edge. jsdom does not compute
 * widths, so what prevents it is checked: the row can wrap
 * (`flex-wrap`, `min-w-0`), the trash button does not shrink and sticks to the right
 * (`shrink-0`, `ml-auto`) and there is no longer a spacer pushing it.
 */
import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import AgentsView from "./AgentsView.svelte";

vi.mock("$lib/services/agents", () => ({
  listAgents: async () => [
    {
      id: "a1",
      name: "An agent with a very long name that does not fit on the card",
      model: "gpt-4",
      status: "active",
      totalTraces: 3,
      totalTokens: 1200,
    },
  ],
  createAgent: async () => ({}),
  deleteAgent: async () => ({}),
}));

describe("agent card", () => {
  beforeEach(() => setLocale("en", { reload: false }));

  it("the actions row can wrap and the trash button neither shrinks nor spills out", async () => {
    render(AgentsView);
    const row = await screen.findByTestId("agent-card-actions");
    const trash = screen.getByRole("button", { name: "Delete Agent" });

    expect(row.contains(trash)).toBe(true);
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
    expect(trash.className).toMatch(/\bml-auto\b/);
    expect(trash.className).toMatch(/\bshrink-0\b/);
    // there is no longer a `flex-1` spacer pushing the trash button out
    expect(row.querySelector(".flex-1")).toBeNull();
    // the long name is truncated instead of widening the card
    expect(screen.getByText(/very long name/).className).toMatch(/\btruncate\b/);
  });
});
