/**
 * An IMAGE upload by an
 * agent may be left as a proposal
 * ============================================================================
 *
 * Against the REAL app (test Postgres, the core's kon-media), a real agent
 * in `propose` mode and real human accounts:
 *
 *   · uploads an image (multipart) → 202 + proposal; it does NOT reach the media library;
 *     the bytes wait in `agent_proposal_files`, outside `/media`;
 *   · the thumbnail is only served through the team route (anonymous 401; user,
 *     agent and agent with `admin`, 403), with its real type and no cache;
 *   · approve → the form is rebuilt and executed with the agent's
 *     identity: the image appears in the media library and the held bytes are
 *     deleted; reject or expire → they are deleted and nothing is uploaded;
 *   · what is NOT held (403 KITSUDEN_E_APPROVAL_UNSUPPORTED): a file
 *     that is not an image by its CONTENT (even if it is named .png and says
 *     image/png), a text field with a secret, an image larger than
 *     `APPROVALS_MAX_UPLOAD_MB` and a body that is neither JSON nor an upload;
 *   · an identical retry (another boundary) is the SAME proposal.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { media } from "../../../../packages/core/media/media.schema";
import { db } from "../db";
import {
  agentIdentities,
  agentProposalFiles,
  agentProposals,
  approvalSettings,
} from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { expireProposals, invalidateApprovalsConfig } from "../lib/approvals";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

const ORIGIN = "http://localhost:4321";
let dbAvailable = false;
let admin = { cookie: "", userId: "" };
let editor = { cookie: "", userId: "" };
let user = { cookie: "", userId: "" };
const createdAgents: string[] = [];

/** A real 1×1 PNG (signature + IHDR + IDAT + IEND). */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  ),
  (ch) => ch.charCodeAt(0)
);

async function newAgent(scopes: string[]): Promise<{ id: string; token: string }> {
  const { agent, plainApiKey } = await createAgent({
    name: `img-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  createdAgents.push(agent.id);
  return { id: agent.id, token: plainApiKey };
}

async function request(
  method: string,
  path: string,
  o: {
    token?: string;
    cookie?: string;
    body?: unknown;
    form?: FormData;
    raw?: { type: string; text: string };
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  let body: string | FormData | undefined;
  if (o.form) body = o.form;
  else if (o.raw) {
    headers["Content-Type"] = o.raw.type;
    body = o.raw.text;
  } else if (o.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  return app.request(new Request(`http://localhost:3000${path}`, { method, headers, body }));
}

const asAdmin = (method: string, path: string, body?: unknown) =>
  request(method, path, { cookie: admin.cookie, body });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON bodies read in the test
async function json(r: Response): Promise<any> {
  return r.json();
}

function form(
  name: string,
  bytes: Uint8Array,
  type = "image/png",
  extra: Record<string, string> = {}
) {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  f.append("files", new File([bytes], name, { type }));
  return f;
}

async function inMediaLibrary(name: string): Promise<number> {
  return (await db.select({ id: media.id }).from(media).where(eq(media.originalName, name))).length;
}

async function heldValues(proposalId: string): Promise<number> {
  return (
    await db
      .select({ id: agentProposalFiles.id })
      .from(agentProposalFiles)
      .where(eq(agentProposalFiles.proposalId, proposalId))
  ).length;
}

describe("human approval — image uploads as a proposal", () => {
  let a = { id: "", token: "" };

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    clearQuotaMemory();
    admin = await enterAs(app, {
      email: `img-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Approver",
      role: "admin",
    });
    editor = await enterAs(app, {
      email: `img-editor-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Editor",
      role: "editor",
    });
    user = await enterAs(app, {
      email: `img-user-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "User",
      role: "user",
    });
    await db.delete(approvalSettings);
    invalidateApprovalsConfig();
    const r = await asAdmin("PUT", "/api/approvals/settings", { enabled: true });
    expect(r.status, await r.clone().text()).toBe(200);
    a = await newAgent(["kon:media:upload-media"]);
    const m = await asAdmin("PUT", `/api/approvals/agents/${a.id}/mode`, { mode: "propose" });
    expect(m.status, await m.clone().text()).toBe(200);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(approvalSettings);
    if (createdAgents.length) {
      await db
        .update(agentIdentities)
        .set({ approvalMode: "inherit" })
        .where(inArray(agentIdentities.id, createdAgents));
    }
    invalidateApprovalsConfig();
  });

  it("uploading an image → 202 and proposal; it does not reach the media library; the thumbnail is team-only", async () => {
    if (!dbAvailable) return;
    const name = `approved-${generateTestId()}.png`;
    const r = await request("POST", "/api/media/upload", {
      token: a.token,
      form: form(name, PNG, "image/png", { alt: "Cover" }),
    });
    expect(r.status, await r.clone().text()).toBe(202);
    const body = await json(r);
    expect(body.code).toBe("KITSUDEN_E_APPROVAL_REQUIRED");
    const pid = body.proposal.id as string;

    // Nothing public yet: neither a row in the media library nor a served file.
    expect(await inMediaLibrary(name)).toBe(0);
    expect(await heldValues(pid)).toBe(1);
    const [p] = await db.select().from(agentProposals).where(eq(agentProposals.id, pid));
    expect(p!.contentType).toBe("multipart/form-data");
    expect(JSON.stringify(p!.body)).not.toContain("base64");
    expect((p!.body as { files: unknown[] }).files.length).toBe(1);

    // The detail shows the file; the thumbnail: human staff only.
    const detail = await json(
      await request("GET", `/api/approvals/proposals/${pid}`, { cookie: editor.cookie })
    );
    expect(detail.files.length).toBe(1);
    expect(detail.files[0].mimeType).toBe("image/png");
    const route = `/api/approvals/proposals/${pid}/files/${detail.files[0].id}`;
    const img = await request("GET", route, { cookie: editor.cookie });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("no-store");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect((await request("GET", route)).status).toBe(401);
    expect((await request("GET", route, { cookie: user.cookie })).status).toBe(403);
    expect((await request("GET", route, { token: a.token })).status).toBe(403);
    const boss = await newAgent(["admin"]);
    expect((await request("GET", route, { token: boss.token })).status).toBe(403);

    // Approve: it runs with the agent's identity and appears in the media library.
    const ok = await json(await asAdmin("POST", `/api/approvals/proposals/${pid}/approve`, {}));
    expect(ok.proposal.status, JSON.stringify(ok.proposal.result)).toBe("executed");
    expect(ok.proposal.result.status, JSON.stringify(ok.proposal.result)).toBe(201);
    expect(await inMediaLibrary(name)).toBe(1);
    const [row] = await db.select().from(media).where(eq(media.originalName, name));
    expect(row!.mimeType).toBe("image/png");
    // An agent is not an account: with no signer, the upload has no human author
    // and the agent is kept in metadata.agentId (before, the INSERT failed).
    expect(row!.createdById).toBeNull();
    expect((row!.metadata as { agentId?: string }).agentId).toBe(a.id);
    // What was held was deleted: the thumbnail no longer exists.
    expect(await heldValues(pid)).toBe(0);
    expect((await request("GET", route, { cookie: editor.cookie })).status).toBe(404);
  });

  it("reject → the held bytes are deleted and nothing is uploaded", async () => {
    if (!dbAvailable) return;
    const name = `rejected-${generateTestId()}.png`;
    const r = await request("POST", "/api/media/upload", { token: a.token, form: form(name, PNG) });
    expect(r.status).toBe(202);
    const pid = (await json(r)).proposal.id as string;
    expect(await heldValues(pid)).toBe(1);
    const no = await request("POST", `/api/approvals/proposals/${pid}/reject`, {
      cookie: editor.cookie,
      body: { comment: "no" },
    });
    expect(no.status, await no.clone().text()).toBe(200);
    expect(await heldValues(pid)).toBe(0);
    expect(await inMediaLibrary(name)).toBe(0);
  });

  it("expire → the held bytes are deleted", async () => {
    if (!dbAvailable) return;
    const name = `expired-${generateTestId()}.png`;
    const pid = (
      await json(
        await request("POST", "/api/media/upload", { token: a.token, form: form(name, PNG) })
      )
    ).proposal.id as string;
    expect(await heldValues(pid)).toBe(1);
    await db
      .update(agentProposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentProposals.id, pid));
    expect(await expireProposals()).toBeGreaterThan(0);
    expect(await heldValues(pid)).toBe(0);
    expect(await inMediaLibrary(name)).toBe(0);
  });

  it("an identical retry (another boundary) is the SAME proposal", async () => {
    if (!dbAvailable) return;
    const name = `repeated-${generateTestId()}.png`;
    const p1 = (
      await json(
        await request("POST", "/api/media/upload", { token: a.token, form: form(name, PNG) })
      )
    ).proposal.id;
    const p2 = (
      await json(
        await request("POST", "/api/media/upload", { token: a.token, form: form(name, PNG) })
      )
    ).proposal.id;
    expect(p2).toBe(p1);
    expect(await heldValues(p1)).toBe(1);
  });

  it("what is not an image by its CONTENT is not held, even if it says image/png (403 not_image)", async () => {
    if (!dbAvailable) return;
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
    for (const bytes of [html, pdf]) {
      const before = (
        await db
          .select({ id: agentProposals.id })
          .from(agentProposals)
          .where(eq(agentProposals.agentId, a.id))
      ).length;
      const r = await request("POST", "/api/media/upload", {
        token: a.token,
        form: form(`fake-${generateTestId()}.png`, bytes),
      });
      expect(r.status).toBe(403);
      const c = await json(r);
      expect(c.code).toBe("KITSUDEN_E_APPROVAL_UNSUPPORTED");
      expect(c.reason).toBe("not_image");
      const after = (
        await db
          .select({ id: agentProposals.id })
          .from(agentProposals)
          .where(eq(agentProposals.agentId, a.id))
      ).length;
      expect(after).toBe(before);
    }
  });

  it("a text field with a secret is not held (403 secret)", async () => {
    if (!dbAvailable) return;
    const extras: Record<string, string>[] = [
      { password: "hunter2-secret" },
      { alt: "kitsuden_agent_abcdefghijklmnop" },
    ];
    for (const extra of extras) {
      const r = await request("POST", "/api/media/upload", {
        token: a.token,
        form: form(`secret-${generateTestId()}.png`, PNG, "image/png", extra),
      });
      expect(r.status).toBe(403);
      expect((await json(r)).reason).toBe("secret");
    }
  });

  it("an image larger than APPROVALS_MAX_UPLOAD_MB is not held (403 too_large)", async () => {
    if (!dbAvailable) return;
    const before = process.env.APPROVALS_MAX_UPLOAD_MB;
    process.env.APPROVALS_MAX_UPLOAD_MB = "1";
    try {
      const large = new Uint8Array(1024 * 1024 + 10);
      large.set(PNG);
      const r = await request("POST", "/api/media/upload", {
        token: a.token,
        form: form(`large-${generateTestId()}.png`, large),
      });
      expect(r.status).toBe(403);
      expect((await json(r)).reason).toBe("too_large");
    } finally {
      if (before === undefined) delete process.env.APPROVALS_MAX_UPLOAD_MB;
      else process.env.APPROVALS_MAX_UPLOAD_MB = before;
    }
  });

  it("an agent in direct mode uploads without a proposal (before, the INSERT failed because of created_by_id)", async () => {
    if (!dbAvailable) return;
    const d = await newAgent(["kon:media:upload-media"]);
    const m = await asAdmin("PUT", `/api/approvals/agents/${d.id}/mode`, { mode: "direct" });
    expect(m.status).toBe(200);
    const name = `direct-${generateTestId()}.png`;
    const r = await request("POST", "/api/media/upload", { token: d.token, form: form(name, PNG) });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(await inMediaLibrary(name)).toBe(1);
  });

  it("a body that is neither JSON nor an upload is still not held (403 not_json)", async () => {
    if (!dbAvailable) return;
    const r = await request("POST", "/api/media/upload", {
      token: a.token,
      raw: { type: "text/plain", text: "hello" },
    });
    expect(r.status).toBe(403);
    expect((await json(r)).reason).toBe("not_json");
  });
});
