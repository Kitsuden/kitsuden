import { describe, expect, it } from "vitest";

import { confirmDialog, pendingConfirm, settleConfirm } from "./confirm.svelte";

describe("confirmDialog", () => {
  it("resolves with the user's answer and clears the request", async () => {
    const answer = confirmDialog({ title: "Delete the dataset?", description: "12 entries go." });
    expect(pendingConfirm()?.title).toBe("Delete the dataset?");
    settleConfirm(true);
    await expect(answer).resolves.toBe(true);
    expect(pendingConfirm()).toBeNull();
  });

  it("accepts a bare string as the title", async () => {
    const answer = confirmDialog("Revoke this key?");
    expect(pendingConfirm()?.title).toBe("Revoke this key?");
    settleConfirm(false);
    await expect(answer).resolves.toBe(false);
  });

  it("a second question cancels the first", async () => {
    const first = confirmDialog("One?");
    const second = confirmDialog("Two?");
    await expect(first).resolves.toBe(false);
    expect(pendingConfirm()?.title).toBe("Two?");
    settleConfirm(true);
    await expect(second).resolves.toBe(true);
  });

  it("settling with nothing pending does nothing", () => {
    expect(() => settleConfirm(true)).not.toThrow();
  });
});
