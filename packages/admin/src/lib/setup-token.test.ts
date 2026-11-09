/**
 * The first-run form asks for the one-time setup token only when the API says
 * it is required (`GET /api/system/init-check`), and sends it. See
 * apps/api/src/lib/first-run.ts.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import SetupView from "../views/auth/SetupView.svelte";

import { checkInit, needsSetupToken } from "./auth.svelte";

vi.setConfig({ testTimeout: 60_000 });

function stubApi(initCheck: unknown) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/system/init-check"))
        return new Response(JSON.stringify(initCheck));
      if (String(url).includes("/api/system/setup")) {
        posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ error: "stop here" }), { status: 403 });
      }
      return new Response("{}");
    })
  );
  return posts;
}

async function fill(token?: string) {
  await fireEvent.input(document.querySelector("#name")!, { target: { value: "Owner" } });
  await fireEvent.input(document.querySelector("#email")!, {
    target: { value: "owner@example.com" },
  });
  await fireEvent.input(document.querySelector("#password")!, {
    target: { value: "long-enough-password" },
  });
  await fireEvent.input(document.querySelector("#password-confirm")!, {
    target: { value: "long-enough-password" },
  });
  if (token)
    await fireEvent.input(document.querySelector("#setup-token")!, { target: { value: token } });
}

describe("first-run setup form", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("without the requirement, no token field and no token sent", async () => {
    setLocale("en", { reload: false });
    const posts = stubApi({ initialized: false, setupTokenRequired: false });
    await checkInit();
    expect(needsSetupToken()).toBe(false);
    render(SetupView);
    expect(document.querySelector("#setup-token")).toBeNull();
    await fill();
    await fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).not.toHaveProperty("setupToken");
  });

  it("with the requirement, the field shows, blocks the button while empty, and is sent", async () => {
    setLocale("en", { reload: false });
    const posts = stubApi({ initialized: false, setupTokenRequired: true });
    await checkInit();
    expect(needsSetupToken()).toBe(true);
    render(SetupView);
    expect(screen.getByLabelText("Setup token")).toBeTruthy();
    await fill();
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      true
    );
    await fill(" the-token ");
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false
    );
    await fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.setupToken).toBe("the-token");
  });

  it("the label exists in Spanish too", async () => {
    setLocale("es", { reload: false });
    stubApi({ initialized: false, setupTokenRequired: true });
    await checkInit();
    render(SetupView);
    expect(screen.getByLabelText("Token de instalación")).toBeTruthy();
  });
});
