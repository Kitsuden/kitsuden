/**
 * Top bar and module retry
 * ============================================================================
 *
 * Two failures the panel carried after the translation:
 *
 *   1. The top bar said «Admin» and showed a fixed «A», also for an
 *      editor. Now it shows the real name, role and avatar.
 *   2. `/api/modules` was requested only once: a transient failure at startup
 *      left the menu incomplete until reload. Now it retries with increasing
 *      backoff and, if it keeps failing, the bar offers «Retry».
 *
 * The third piece of the round (the agent card's trash can) is tested in
 * views/system-tools/AgentsView.layout.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";
import { moduleStore } from "$lib/states/modules.svelte";

import CurrentUser from "./CurrentUser.svelte";

const SRC = join(import.meta.dirname, "..", "..", "..");
const read = (...r: string[]) => readFileSync(join(SRC, ...r), "utf8");

const base = { id: "u1", email: "ana@ejemplo.com", image: null };

describe("top bar: who is using the panel", () => {
  beforeEach(() => setLocale("en", { reload: false }));

  it("an editor sees their name, «Editor» and their initial — not «Admin» or an «A»", () => {
    render(CurrentUser, { props: { user: { ...base, name: "berta", role: "editor" } } });
    expect(screen.getByTestId("user-name").textContent?.trim()).toBe("berta");
    expect(screen.getByTestId("user-role").textContent?.trim()).toBe("Editor");
    expect(screen.getByTestId("user-avatar").textContent?.trim()).toBe("B");
    expect(screen.getByTestId("user-avatar").getAttribute("aria-label")).toBe("berta (Editor)");
  });

  it("an admin comes out as «Administrator»", () => {
    render(CurrentUser, { props: { user: { ...base, name: "Ana", role: "admin" } } });
    expect(screen.getByTestId("user-role").textContent?.trim()).toBe("Administrator");
  });

  it("in Spanish the role is translated too", () => {
    setLocale("es", { reload: false });
    render(CurrentUser, { props: { user: { ...base, name: "Ana", role: "admin" } } });
    expect(screen.getByTestId("user-role").textContent?.trim()).toBe("Administrador");
  });

  it("with no name, it uses the local part of the email", () => {
    render(CurrentUser, { props: { user: { ...base, name: "", role: "editor" } } });
    expect(screen.getByTestId("user-name").textContent?.trim()).toBe("ana");
    expect(screen.getByTestId("user-avatar").textContent?.trim()).toBe("A");
  });

  it("with an http(s) image it renders the avatar", () => {
    render(CurrentUser, {
      props: {
        user: { ...base, name: "Ana", role: "admin", image: "https://cdn.ejemplo.com/a.png" },
      },
    });
    const img = screen.getByTestId("user-avatar").querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://cdn.ejemplo.com/a.png");
  });

  it("an image with another scheme is ignored and the initial remains", () => {
    render(CurrentUser, {
      props: { user: { ...base, name: "Ana", role: "admin", image: "javascript:alert(1)" } },
    });
    expect(screen.getByTestId("user-avatar").querySelector("img")).toBeNull();
    expect(screen.getByTestId("user-avatar").textContent?.trim()).toBe("A");
  });

  it("the bar no longer has the fixed «A» and uses the component", () => {
    const layout = read("lib", "components", "layout", "SidebarLayout.svelte");
    expect(layout).not.toMatch(/>\s*A\s*<\/div>/);
    expect(layout).not.toContain('t("sidebarLayout.admin")');
    expect(layout).toContain("<CurrentUser {user} />");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const response = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const LIST = { docs: [{ key: "kon-blog", name: "Blog", enabled: true }], categories: {} };

describe("fetchModules retries transient failures", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    moduleStore.modules = [];
    moduleStore.error = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a network error and then success: it loads the list and leaves no error", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response(200, LIST));
    const p = moduleStore.fetchModules({ wait: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(moduleStore.modules.map((m) => m.key)).toEqual(["kon-blog"]);
    expect(moduleStore.error).toBeNull();
    expect(moduleStore.loading).toBe(false);
  });

  it("increasing wait (100, 200) and gives up on the third attempt", async () => {
    fetchMock.mockResolvedValue(response(503));
    const p = moduleStore.fetchModules({ attempts: 3, wait: 100 });

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(moduleStore.error).toBeTruthy();
    expect(moduleStore.loading).toBe(false);
  });

  it("a 403 is not retried: waiting does not change the session", async () => {
    fetchMock.mockResolvedValue(response(403));
    await moduleStore.fetchModules({ wait: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(moduleStore.error).toBeTruthy();
  });

  it("a new call takes precedence over the one that was waiting", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response(200, LIST));
    const old = moduleStore.fetchModules({ wait: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await moduleStore.fetchModules();
    await vi.advanceTimersByTimeAsync(1000);
    await old;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(moduleStore.error).toBeNull();
    expect(moduleStore.modules).toHaveLength(1);
  });

  it("the sidebar shows «Retry» when it gives up", () => {
    const layout = read("lib", "components", "layout", "SidebarLayout.svelte");
    expect(layout).toMatch(/\{#if isAdmin && moduleStore\.error\}/);
    expect(layout).toMatch(/onclick=\{\(\) => moduleStore\.fetchModules\(\)\}/);
    expect(layout).toContain('t("common.retry")');
  });
});
