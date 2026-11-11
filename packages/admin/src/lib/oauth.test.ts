/**
 * OAuth for MCP in the panel: consent and connections
 * ============================================================================
 *
 * Contract with apps/api/src/routes/oauth.ts: the consent screen
 * shows client, redirect (with a warning if it is localhost) and agents; it checks
 * by default what applies; approving sends agent + scopes and follows the redirect;
 * the connections list revokes. See docs/agents/oauth.md.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Connections from "$lib/components/connections/OAuthClients.svelte";
import * as confirmModule from "$lib/confirm.svelte";
import { setLocale } from "$lib/i18n";
import { inputScopes } from "$lib/services/oauth";

import Consent from "../routes/oauth/consent/+page.svelte";

vi.setConfig({ testTimeout: 60_000 });

vi.mock("$app/stores", () => ({
  page: {
    subscribe(run: (v: unknown) => void) {
      run({
        url: new URL("http://localhost/oauth/consent?request=11111111-1111-1111-1111-111111111111"),
        params: {},
      });
      return () => {};
    },
  },
}));

const BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/oauth`;
const REQUEST = "11111111-1111-1111-1111-111111111111";

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: "", json: async () => body } as Response;
}

const VIEW = {
  request: {
    id: REQUEST,
    expiresAt: new Date().toISOString(),
    requestedScopes: ["mcp:connect", "mcp:read"],
    resource: "http://localhost:3000/api/mcp",
  },
  client: {
    id: "kc_abc",
    name: "Claude Code",
    kind: "dcr",
    uri: null,
    logoUri: null,
    softwareId: null,
    redirectUri: "http://localhost:33418/callback",
    redirectHost: "localhost:33418",
    localhostRedirect: true,
    registeredAt: new Date().toISOString(),
  },
  human: { id: "u1", role: "admin", canCreateAgent: true },
  basicScopes: ["mcp:connect", "mcp:read", "mcp:write"],
  agents: [
    {
      id: "a1",
      name: "Reader",
      description: null,
      grantable: ["mcp:connect", "mcp:read", "brain:read"],
      notDelegable: [],
      denies: ["!kon:crm:*"],
      sponsorUserId: null,
    },
  ],
};

describe("inputScopes", () => {
  it("ticks only what was asked for, and mcp:connect: nothing the client did not request", () => {
    const basic = ["mcp:connect", "mcp:read", "mcp:write"];
    expect(inputScopes([], basic, ["mcp:connect", "brain:read"])).toEqual(["mcp:connect"]);
    expect(inputScopes(["mcp:connect"], basic, ["mcp:connect", "admin"])).toEqual(["mcp:connect"]);
    expect(inputScopes(["mcp:read"], basic, ["mcp:connect", "mcp:read", "brain:read"])).toEqual([
      "mcp:connect",
      "mcp:read",
    ]);
    expect(inputScopes(["brain:read"], basic, ["mcp:connect", "mcp:read", "brain:read"])).toEqual([
      "mcp:connect",
      "brain:read",
    ]);
    expect(inputScopes(["admin"], basic, ["mcp:connect"])).toEqual(["mcp:connect"]);
  });
});

describe("consent screen", () => {
  let target = "";
  beforeEach(() => {
    setLocale("en", { reload: false });
    target = "";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        get href() {
          return target;
        },
        set href(v: string) {
          target = v;
        },
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows client and localhost warning; approving sends agent and scopes and redirects", async () => {
    const calls: { what: string; body?: unknown }[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        what: `${init?.method ?? "GET"} ${String(url)}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if ((init?.method ?? "GET") === "GET") return response(VIEW);
      return response({
        redirectTo:
          "http://localhost:33418/callback?code=x&state=s&iss=http%3A%2F%2Flocalhost%3A3000",
      });
    }) as typeof fetch;

    render(Consent);
    await screen.findByText("Connect Claude Code to Kitsuden");
    expect(screen.getByTestId("oauth-localhost-warning").textContent).toContain("localhost:33418");
    expect(screen.getByText(/Always denied for this agent: !kon:crm:\*/)).toBeTruthy();
    // A single agent: selected. What the client did not ask for stays unticked.
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((c) => c.checked)).toEqual([true, true, false]);
    await fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(target).toContain("code=x"));
    expect(calls[0]!.what).toBe(`GET ${BASE}/consent/${REQUEST}`);
    expect(calls[1]).toEqual({
      what: `POST ${BASE}/consent/${REQUEST}`,
      body: { decision: "approve", agentId: "a1", scopes: ["mcp:connect", "mcp:read"] },
    });
  });

  it("without mcp:connect it does not allow approving; denying sends deny", async () => {
    const calls: unknown[] = [];
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return response(VIEW);
      calls.push(JSON.parse(String(init!.body)));
      return response({ redirectTo: "http://localhost:33418/callback?error=access_denied" });
    }) as typeof fetch;
    render(Consent);
    await screen.findByText("Connect Claude Code to Kitsuden");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    await fireEvent.click(boxes[0]!); // remove mcp:connect
    expect((screen.getByText("Allow").closest("button") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => expect(target).toContain("access_denied"));
    expect(calls).toEqual([{ decision: "deny" }]);
  });

  it("an expired request says so", async () => {
    global.fetch = vi.fn(async () => response({ error: "not found" }, 404)) as typeof fetch;
    render(Consent);
    expect((await screen.findByTestId("oauth-consent-error")).textContent).toContain("expired");
  });
});

describe("OAuth connections", () => {
  beforeEach(() => setLocale("en", { reload: false }));

  it("lists and revokes", async () => {
    // Revoking asks through the panel dialog ($lib/confirm.svelte), not the browser confirm().
    const asked = vi.spyOn(confirmModule, "confirmDialog").mockResolvedValue(true);
    const calls: string[] = [];
    let revoked = false;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "DELETE") {
        revoked = true;
        return response({ revoked: true });
      }
      return response({
        grants: revoked
          ? []
          : [
              {
                id: "g1",
                client: {
                  id: "kc_abc",
                  name: "Claude Code",
                  kind: "dcr",
                  uri: null,
                  logoUri: null,
                },
                agent: { id: "a1", name: "Reader" },
                grantedBy: { id: "u1", name: "Admin", email: null },
                scopes: ["mcp:connect", "mcp:read"],
                createdAt: new Date().toISOString(),
                lastUsedAt: null,
                revokedAt: null,
                revokedReason: null,
              },
            ],
      });
    }) as typeof fetch;
    render(Connections);
    await screen.findByText("Claude Code");
    expect(screen.getByText("mcp:connect mcp:read")).toBeTruthy();
    await fireEvent.click(screen.getByText("Revoke"));
    await screen.findByTestId("oauth-connections-empty");
    expect(asked).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([`GET ${BASE}/grants`, `DELETE ${BASE}/grants/g1`, `GET ${BASE}/grants`]);
  });
});
