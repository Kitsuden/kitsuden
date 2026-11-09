/**
 * The token that /api/v1/agents returns really authenticates
 * ============================================================================
 *
 * `POST /api/v1/agents` and `POST /api/v1/agents/:id/token` (the ones the
 * panel uses) stored the key without `keyId` or `algorithm`. `authenticateAgent`
 * looks up by `keyId`, so the freshly issued token always got 401: an
 * agent created from the panel could never connect.
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { app } from "../index";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;

function req(path: string, opts: RequestInit = {}, cookie?: string, bearer?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (opts.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

/** GET /api/mcp opens an SSE: the status is enough; the body is cancelled */
async function authenticates(token: string): Promise<number> {
  const res = await app.request(req("/api/mcp", {}, undefined, token));
  await res.body?.cancel().catch(() => {});
  return res.status;
}

describe("/api/v1/agents: the issued token authenticates", () => {
  let cookie = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie } = await enterAs(app, {
      email: `v1-token-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "V1 Token",
      role: "admin",
    }));
  });

  it("the token of a freshly created agent connects to MCP (before: 401)", async () => {
    if (!dbAvailable) return;
    const res = await app.request(
      req(
        "/api/v1/agents",
        { method: "POST", body: JSON.stringify({ name: `v1-${generateTestId()}` }) },
        cookie
      )
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { id: string }; token: string };
    expect(await authenticates(body.token)).toBe(200);
  });

  it("the regenerated token also connects", async () => {
    if (!dbAvailable) return;
    const createdItem = await app.request(
      req(
        "/api/v1/agents",
        { method: "POST", body: JSON.stringify({ name: `v1-${generateTestId()}` }) },
        cookie
      )
    );
    const { agent } = (await createdItem.json()) as { agent: { id: string } };
    const res = await app.request(
      req(`/api/v1/agents/${agent.id}/token`, { method: "POST" }, cookie)
    );
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(await authenticates(token)).toBe(200);
  });
});
