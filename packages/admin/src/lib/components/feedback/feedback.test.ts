/**
 * The one confirmation dialog the panel asks through (`confirmDialog()` + ConfirmHost).
 * Empty and error states are tallao's EmptyState now; its tests live in the kit.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmDialog, settleConfirm } from "$lib/confirm.svelte";
import { setLocale } from "$lib/i18n";

import ConfirmHost from "./ConfirmHost.svelte";

beforeEach(() => setLocale("en", { reload: false }));

describe("ConfirmHost", () => {
  afterEach(() => settleConfirm(false));

  it("shows the question in a dialog and resolves with the button pressed", async () => {
    render(ConfirmHost);
    const answer = confirmDialog({
      title: "Disable Blog?",
      description: "Blog leaves the menu.",
      confirmLabel: "Disable",
    });
    await tick();
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    await waitFor(() => expect(dialog!.textContent).toContain("Disable Blog?"));
    expect(dialog!.textContent).toContain("Blog leaves the menu.");
    await fireEvent.click(screen.getByRole("button", { name: "Disable", hidden: true }));
    await expect(answer).resolves.toBe(true);
  });

  it("Cancel resolves false", async () => {
    render(ConfirmHost);
    const answer = confirmDialog("Revoke this key?");
    await tick();
    await waitFor(() => expect(document.querySelector("dialog")?.textContent).toContain("Revoke"));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
    await expect(answer).resolves.toBe(false);
  });
});
