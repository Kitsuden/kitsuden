/**
 * Code promotion: a version's path in the panel
 * ============================================================================
 *
 * The «Code promotion» tab of Approvals shows each step (tests,
 * scan, capabilities, decision with its translated reasons, monitoring), lets you
 * approve or reject what is waiting, roll back what is active (with a mandatory
 * reason) and change each agent's mode. All against the panel's API
 * (`/api/approvals/promotion`), with the session.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import CodePromotion from "./CodePromotion.svelte";

vi.mock("$lib/auth.svelte", () => ({ isAdmin: () => true }));
vi.setConfig({ testTimeout: 60_000 });

const BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/approvals/promotion`;
const ID = "22222222-2222-2222-2222-222222222222";

function version(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    target: { kind: "action", actionId: "a1", slug: "sum", name: "Sum" },
    versionNumber: 3,
    origin: "agent",
    status,
    mode: "turbo",
    agentId: "ag1",
    agentName: "Coder",
    sponsorUserId: null,
    sponsorName: null,
    channel: "mcp",
    description: "sum a and b",
    contentHash: "abcdef0123456789",
    baseHash: "fedcba9876543210",
    parentVersionId: null,
    previousVersionId: "p1",
    capabilities: {
      scopes: ["datasets:*:read"],
      fetchAllow: [],
      timeoutMs: 5000,
      memoryLimitMb: 64,
      maxCalls: 50,
    },
    testCount: 1,
    testReport: {
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      fromTarget: 0,
      durationMs: 400,
      cases: [
        {
          name: "adds",
          status: "passed",
          durationMs: 200,
          exitReason: "success",
          error: null,
          mismatches: [],
          unmockedCalls: [],
          logs: "",
        },
        {
          name: "wrong",
          status: "failed",
          durationMs: 200,
          exitReason: "success",
          error: null,
          mismatches: ["result differs"],
          unmockedCalls: ["GET /api/x"],
          logs: "",
        },
      ],
    },
    scanReport: {
      passed: true,
      bytes: 40,
      findings: [],
      apiCalls: [],
      fetchHosts: [],
      envVars: [],
    },
    capabilityDiff: {
      newTarget: false,
      scopesAdded: ["datasets:*:read"],
      scopesRemoved: [],
      denialsRemoved: [],
      denialsAdded: [],
      hostsAdded: [],
      hostsRemoved: [],
      limitsIncreased: [],
    },
    decision: {
      route: "proposal",
      reasons: ["tests_failed", "scope_escalation"],
      mode: "turbo",
      turboAllowed: true,
      touches: [],
      sensitiveCalls: [],
    },
    proposal: { id: "pp1", statusUrl: "/api/proposals/pp1" },
    activatedAt: null,
    activatedBy: null,
    watchUntil: null,
    watch: null,
    rolledBackAt: null,
    rolledBackBy: null,
    rollbackReason: null,
    activationError: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    ...extra,
  };
}

const settings = {
  config: { turboAllowed: false, watchMinutes: 30, minExecutions: 3, maxErrorRate: 0.5 },
  updatedBy: null,
  updatedAt: null,
  approvalsEnabled: false,
  codeActionsEnabled: false,
  agents: [
    {
      id: "ag1",
      name: "Coder",
      isActive: true,
      mode: "turbo",
      approvalMode: "inherit",
      canPropose: true,
    },
  ],
};

const response = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as Response;
let requestedOnes: { method: string; url: string; body?: string; credentials?: string }[] = [];

function simular(status: string) {
  requestedOnes = [];
  let actual = version(status);
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    requestedOnes.push({
      method,
      url: u,
      body: init?.body as string | undefined,
      credentials: init?.credentials,
    });
    if (u.endsWith("/settings")) return response(settings);
    if (u.includes("/agents/"))
      return response({ agentId: "ag1", mode: "suggestion", previous: "turbo" });
    if (u.endsWith("/approve"))
      actual = version("active", {
        activatedAt: "2026-10-28T11:00:00.000Z",
        activatedBy: "u1",
        activatedByName: "Ana",
      });
    if (u.endsWith("/rollback"))
      actual = version("rolled_back", {
        rolledBackAt: "2026-10-28T12:00:00.000Z",
        rollbackReason: "bad",
      });
    if (u.includes(`/versions/${ID}`)) {
      return response({
        version: { ...actual, code: "return 1;", tests: [] },
        previous: null,
        proposal: {
          id: "pp1",
          status: "pending",
          decidedBy: null,
          decidedAt: null,
          comment: null,
          expiresAt: "2026-11-01T00:00:00.000Z",
          resultStatus: null,
          resultError: null,
        },
        events: [
          {
            id: "e1",
            at: "2026-10-28T10:00:00.000Z",
            action: "promotion_submitted",
            by: null,
            byName: null,
            success: true,
            details: {},
          },
        ],
      });
    }
    return response({ versions: [actual] });
  }) as typeof fetch;
}

describe("code promotion in the panel", () => {
  afterEach(() => setLocale("en", { reload: false }));

  it("shows a version's path and approves it with the session (en)", async () => {
    setLocale("en", { reload: false });
    simular("awaiting_approval");
    render(CodePromotion, { props: { initialVersion: ID } });

    await screen.findByTestId("step-tests");
    expect(screen.getByTestId("step-tests").textContent).toContain(
      "1 passed, 1 failed, 0 errored of 2"
    );
    expect(screen.getByTestId("step-tests").textContent).toContain(
      "Calls without a simulated response: GET /api/x"
    );
    expect(screen.getByTestId("code-actions-off")).toBeTruthy();
    const reasons = screen.getAllByTestId("reason").map((n) => n.textContent?.trim());
    expect(reasons).toEqual(["A test failed", "It asks for more scopes than the active version"]);
    expect(screen.getByTestId("promotion-code").textContent).toBe("return 1;");

    await fireEvent.click(screen.getByText("Approve and activate"));
    await waitFor(() =>
      expect(screen.getByTestId("detail-status").textContent?.trim()).toBe("Active")
    );
    const approve = requestedOnes.find((p) => p.url === `${BASE}/versions/${ID}/approve`);
    expect(approve?.method).toBe("POST");
    expect(approve?.credentials).toBe("include");
  });

  it("rollback: requires a reason and sends it (es)", async () => {
    setLocale("es", { reload: false });
    simular("active");
    render(CodePromotion, { props: { initialVersion: ID } });
    const zona = await screen.findByTestId("promotion-rollback");
    const button = zona.querySelector("button")!;
    expect(button.disabled).toBe(true);
    await fireEvent.input(zona.querySelector("input")!, {
      target: { value: "fails in production" },
    });
    await waitFor(() => expect(button.disabled).toBe(false));
    await fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("detail-status").textContent?.trim()).toBe("Vuelta atrás")
    );
    const round = requestedOnes.find((p) => p.url.endsWith("/rollback"));
    expect(JSON.parse(round!.body!)).toEqual({ reason: "fails in production" });
  });

  it("changes an agent's mode", async () => {
    setLocale("en", { reload: false });
    simular("awaiting_approval");
    render(CodePromotion, { props: {} });
    const select = (await screen.findByTestId("promotion-mode-ag1")) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "suggestion" } });
    await waitFor(() =>
      expect(
        requestedOnes.some((p) => p.method === "PUT" && p.url === `${BASE}/agents/ag1/mode`)
      ).toBe(true)
    );
    const put = requestedOnes.find((p) => p.method === "PUT" && p.url.endsWith("/mode"));
    expect(JSON.parse(put!.body!)).toEqual({ mode: "suggestion" });
  });
});
