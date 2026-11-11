/**
 * `whenLoaded`: one request for the module list, however many ask.
 *
 * The post editor and the layout both did `if (modules.length === 0) await fetchModules()`.
 * The second call superseded the first, whose promise resolved with the list still empty;
 * the editor read that as "kon-games may be on" and asked for its routes (two 404s).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { moduleStore } from "./modules.svelte";

const answer = (docs: unknown[]) =>
  ({ ok: true, status: 200, json: async () => ({ docs }) }) as Response;

describe("moduleStore.whenLoaded", () => {
  beforeEach(() => {
    moduleStore.modules = [];
    moduleStore.loaded = false;
    moduleStore.error = null;
  });

  it("asks once for callers that arrive together, and all of them see the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(answer([{ key: "kon-blog", enabled: true, type: "kon" }]));
    global.fetch = fetchMock;

    await Promise.all([
      moduleStore.whenLoaded(),
      moduleStore.whenLoaded(),
      moduleStore.whenLoaded(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(moduleStore.loaded).toBe(true);
    expect(moduleStore.activeKon("kon-blog")).toBe(true);
    expect(moduleStore.activeKon("kon-games")).toBe(false);
  });

  it("does not ask again once the list is there", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer([]));
    global.fetch = fetchMock;
    await moduleStore.whenLoaded();
    await moduleStore.whenLoaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // An empty list that ARRIVED is an answer: no kon is on.
    expect(moduleStore.loaded).toBe(true);
  });

  it("waits for the request that superseded the one it joined", async () => {
    let release!: (r: Response) => void;
    const slow = new Promise<Response>((r) => (release = r));
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(answer([{ key: "kon-games", enabled: true, type: "kon" }]));
    global.fetch = fetchMock;

    const waiting = moduleStore.whenLoaded(); // joins the first request
    const second = moduleStore.fetchModules(); // someone presses "Retry": supersedes it
    release(answer([])); // the first one answers late and must not be taken as the list
    await Promise.all([waiting, second]);

    expect(moduleStore.loaded).toBe(true);
    expect(moduleStore.activeKon("kon-games")).toBe(true);
  });

  it("leaves `loaded` false when the list could not be fetched", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
    await moduleStore.whenLoaded();
    expect(moduleStore.loaded).toBe(false);
    expect(moduleStore.error).toBeTruthy();
  });
});
