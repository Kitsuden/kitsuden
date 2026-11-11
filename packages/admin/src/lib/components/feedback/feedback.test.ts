/**
 * The shared empty/error state and the dialogs the panel asks through.
 *
 * A failed load used to look like "nothing here" (an empty table, sometimes next to the
 * error). StateMessage is the single shape for both, and the error always carries Retry.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AutoFormModal from "$lib/components/admin/AutoFormModal.svelte";
import { confirmDialog, settleConfirm } from "$lib/confirm.svelte";
import { setLocale } from "$lib/i18n";

import ConfirmHost from "./ConfirmHost.svelte";
import StateMessage from "./StateMessage.svelte";

beforeEach(() => setLocale("en", { reload: false }));

describe("StateMessage", () => {
  it("an error is an alert with the reason and a Retry that calls back", async () => {
    const onRetry = vi.fn();
    render(StateMessage, {
      props: {
        kind: "error",
        title: "Could not load the datasets",
        description: "HTTP 500",
        onRetry,
      },
    });
    const box = screen.getByRole("alert");
    expect(box.textContent).toContain("Could not load the datasets");
    expect(box.textContent).toContain("HTTP 500");
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("an empty state is a status, with no Retry", () => {
    render(StateMessage, { props: { title: "No datasets yet" } });
    expect(screen.getByRole("status").textContent).toContain("No datasets yet");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Retry is disabled while a retry runs", () => {
    render(StateMessage, {
      props: { kind: "error", title: "x", onRetry: () => {}, retrying: true },
    });
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

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

describe("AutoFormModal", () => {
  const columns = [
    { name: "id", type: "uuid", nullable: false, isPrimary: true },
    { name: "name", type: "text", nullable: false },
    { name: "active", type: "boolean", nullable: true },
    { name: "departmentId", type: "uuid", nullable: true },
  ];

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.endsWith("/api/explorer/tables")
        ? { tables: [{ key: "directory_employees" }, { key: "directory_departments" }] }
        : u.endsWith("/api/explorer/directory_departments/options")
          ? { options: [{ value: "d1", label: "Roastery" }] }
          : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it("is a real dialog, named by its title, with every field labelled", async () => {
    render(AutoFormModal, {
      props: { tableName: "directory_employees", columns: columns as never, editData: null },
    });
    await tick();
    const dialog = document.querySelector("dialog")!;
    expect(dialog).not.toBeNull();
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)?.textContent).toContain("New record");
    for (const label of dialog.querySelectorAll("label[for]")) {
      expect(dialog.querySelector(`[id="${label.getAttribute("for")}"]`)).not.toBeNull();
    }
    // The primary key is not a field of the form.
    expect(dialog.textContent).not.toMatch(/\bId\b\s*\*/);
  });

  it("a relation column lists the records of the kon's own table", async () => {
    render(AutoFormModal, {
      props: { tableName: "directory_employees", columns: columns as never, editData: null },
    });
    await waitFor(() => {
      const options = [...document.querySelectorAll("dialog select option")].map(
        (o) => o.textContent
      );
      expect(options).toContain("Roastery");
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/explorer/directory_departments/options"),
      expect.anything()
    );
  });

  it("closing it calls back (Cancel)", async () => {
    const onclose = vi.fn();
    render(AutoFormModal, {
      props: { tableName: "directory_employees", columns: columns as never, onclose },
    });
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
    expect(onclose).toHaveBeenCalled();
  });
});
