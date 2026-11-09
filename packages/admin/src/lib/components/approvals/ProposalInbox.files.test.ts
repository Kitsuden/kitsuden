/**
 * Approval inbox: the IMAGES of a held upload
 * ============================================================================
 *
 * Owner's decision: an agent can leave an image upload as a proposal.
 * The detail shows each image as a thumbnail, requested from the team route
 * (`/api/approvals/proposals/:id/files/:fileId`) with the session, and warns
 * when the images have already been deleted (decided or expired).
 */
import { render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "$lib/i18n";

import ProposalInbox from "./ProposalInbox.svelte";

vi.setConfig({ testTimeout: 60_000 });

const BASE = import.meta.env.VITE_API_URL ?? "";

const proposal = {
  id: "11111111-1111-1111-1111-111111111111",
  status: "pending",
  reason: "propose_only",
  channel: "rest",
  method: "POST",
  path: "/api/media/upload",
  tool: null,
  operation: "kon:media:upload-media",
  createdAt: "2026-10-26T10:00:00.000Z",
  expiresAt: "2026-10-27T10:00:00.000Z",
  decidedAt: null,
  comment: null,
  executedAt: null,
  statusUrl: "/api/proposals/11111111-1111-1111-1111-111111111111",
  agentId: "ag1",
  agentName: "Photographer",
  decidedBy: null,
  decidedByName: null,
};

function detail(files: unknown[]) {
  return {
    ...proposal,
    keyId: null,
    body: { multipart: true, fields: [], files: [] },
    contentType: "multipart/form-data",
    idempotencyKey: null,
    scopes: ["kon:media:upload-media"],
    diff: { kind: "create", proposed: {} },
    konId: "kon-media",
    operationId: "upload-media",
    canDecide: true,
    cannotDecideReason: null,
    files,
  };
}

const response = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: "",
    json: async () => body,
    blob: async () => new Blob(["x"]),
  }) as Response;

let requestedOnes: string[] = [];

function simular(files: unknown[]) {
  requestedOnes = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    requestedOnes.push(`${init?.credentials ?? ""} ${u}`);
    if (u.includes("/files/")) return response(null);
    if (u.endsWith(`/proposals/${proposal.id}`)) return response(detail(files));
    if (u.endsWith("/count")) return response({ pending: 1 });
    return response({ total: 1, proposals: [proposal] });
  }) as typeof fetch;
}

describe("inbox: thumbnails of a held upload", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:miniatura");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => setLocale("en", { reload: false }));

  it("shows each image requested with the session from the team route (en)", async () => {
    setLocale("en", { reload: false });
    simular([
      { id: "f1", field: "files", filename: "cover.png", mimeType: "image/png", size: 2048 },
    ]);
    render(ProposalInbox, { props: { initialId: proposal.id } });

    const img = await screen.findByTestId("proposal-thumbnail");
    expect(img.getAttribute("src")).toBe("blob:miniatura");
    expect(img.getAttribute("alt")).toBe("Image cover.png");
    expect(screen.getByText("Uploaded images")).toBeTruthy();
    expect(requestedOnes).toContain(
      `include ${BASE}/api/approvals/proposals/${proposal.id}/files/f1`
    );
  });

  it("in Spanish, and if the images were already deleted it says so", async () => {
    setLocale("es", { reload: false });
    simular([]);
    render(ProposalInbox, { props: { initialId: proposal.id } });
    await waitFor(() => expect(screen.getByTestId("proposal-files-removed")).toBeTruthy());
    expect(screen.getByTestId("proposal-files-removed").textContent?.trim()).toBe(
      "Las imágenes retenidas se borraron."
    );
    expect(screen.queryByTestId("proposal-thumbnail")).toBeNull();
  });
});
