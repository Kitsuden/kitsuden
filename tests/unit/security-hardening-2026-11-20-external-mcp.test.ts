/**
 * Security hardening 2026-11-20: external MCP servers
 * ============================================================================
 *
 * 1. The transport and the OAuth requests checked the host's addresses and then
 *    called `fetch`, which resolved the name again (DNS rebinding). They now go
 *    through `pinnedFetch`: the connection uses the addresses that were checked.
 * 2. A URL on another origin kept the stored auth header, which was then sent to
 *    the new host. It is now dropped unless the same change sets a new header.
 * 3. The protected-resource `resource` and the authorization server's `issuer`
 *    were not compared with the server they were read for.
 * 4. Two servers whose names give the same slug shared tool names and scopes; a
 *    second one is now refused.
 * 5. The token endpoint's `token_type` and `error` were reflected into the panel
 *    message as they came; only a plain code is shown now.
 */
import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({ db: { execute: async () => [] } }));

import {
  headerDroppedByUrlChange,
  withExternalMcpClient,
} from "../../apps/api/src/lib/external-mcp";
import { serverSlugTakenBy } from "../../apps/api/src/lib/external-mcp-bridge";
import {
  discoverAuthorizationServer,
  issuerMatches,
  resourceMatches,
  shownCode,
} from "../../apps/api/src/lib/external-mcp-oauth";
import { externalMcpFetch, serverTargetProblem } from "../../apps/api/src/lib/external-mcp-target";
import { setResolverForTests } from "../../apps/api/src/lib/safe-fetch";

describe("DNS rebinding", () => {
  const before = process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL;
  beforeEach(() => {
    delete process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL;
  });
  afterEach(() => {
    setResolverForTests(null);
    if (before === undefined) delete process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL;
    else process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL = before;
  });

  /** Public on the first answer, the cloud metadata address after it. */
  const rebinding = () => {
    let calls = 0;
    setResolverForTests(async () =>
      calls++ === 0
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }]
    );
  };

  it("the target check refuses a host that resolves to an internal address", async () => {
    setResolverForTests(async () => [{ address: "10.0.0.5", family: 4 }]);
    expect(await serverTargetProblem("https://mcp.example.test/mcp")).toMatch(/non-public/);
  });

  it("the request never connects to a second, internal answer", async () => {
    rebinding();
    expect(await serverTargetProblem("https://mcp.example.test/mcp")).toBeNull();
    await expect(
      externalMcpFetch("https://mcp.example.test/mcp", { timeoutMs: 2000 })
    ).rejects.toThrow(/non-public/);
  });

  it("OAuth discovery checks and connects with the same answer", async () => {
    rebinding();
    await expect(discoverAuthorizationServer("https://mcp.example.test/mcp")).rejects.toThrow(
      /non-public/
    );
  });
});

describe("the pinned transport still speaks MCP", () => {
  let server: Server;
  let port = 0;
  const authSeen: string[] = [];
  beforeAll(async () => {
    process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL = "true";
    server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      authSeen.push(String(req.headers.authorization ?? ""));
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (msg.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        const result =
          msg.method === "initialize"
            ? {
                protocolVersion: msg.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fake", version: "1.0.0" },
              }
            : msg.method === "tools/list"
              ? { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] }
              : {};
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server?.close();
    delete process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL;
  });

  it("lists the tools and sends the auth header", async () => {
    const names = await withExternalMcpClient(
      `http://127.0.0.1:${port}/mcp`,
      { name: "Authorization", value: "Bearer test-token" },
      "review",
      async (client) => (await client.listTools()).tools.map((t) => t.name)
    );
    expect(names).toEqual(["search"]);
    expect(authSeen.every((a) => a === "Bearer test-token")).toBe(true);
  });
});

describe("a new URL and the stored auth header", () => {
  const url = "https://mcp.example.test/mcp";
  it("another origin drops it", () => {
    expect(headerDroppedByUrlChange(url, { url: "https://evil.example.test/mcp" })).toBe(true);
    expect(headerDroppedByUrlChange(url, { url: "https://mcp.example.test:8443/mcp" })).toBe(true);
  });
  it("the same origin, no URL change, or a new header in the same change keep it", () => {
    expect(headerDroppedByUrlChange(url, { url: "https://mcp.example.test/v2/mcp" })).toBe(false);
    expect(headerDroppedByUrlChange(url, {})).toBe(false);
    expect(
      headerDroppedByUrlChange(url, {
        url: "https://other.example.test/mcp",
        authHeaderName: "Authorization",
        authHeaderValue: "Bearer new",
      })
    ).toBe(false);
  });
});

describe("OAuth metadata names the right server", () => {
  it("resource must be the server URL or its origin", () => {
    const server = "https://mcp.example.test/mcp";
    expect(resourceMatches(server, server)).toBe(true);
    expect(resourceMatches("https://mcp.example.test/mcp/", server)).toBe(true);
    expect(resourceMatches("https://mcp.example.test", server)).toBe(true);
    expect(resourceMatches(undefined, server)).toBe(true);
    expect(resourceMatches("https://other.example.test/mcp", server)).toBe(false);
    expect(resourceMatches(42, server)).toBe(false);
  });
  it("issuer must be the authorization server it was read from", () => {
    expect(issuerMatches("https://auth.example.test/", "https://auth.example.test")).toBe(true);
    expect(issuerMatches(undefined, "https://auth.example.test")).toBe(true);
    expect(issuerMatches("https://evil.example.test", "https://auth.example.test")).toBe(false);
  });
});

describe("server names that give the same tool names", () => {
  const servers = [{ id: "s1", name: "GitHub" }];
  it("a second server with the same slug is found", () => {
    expect(serverSlugTakenBy("github", servers)).toEqual(servers[0]);
    expect(serverSlugTakenBy("Git Hub", servers)).toBeNull();
  });
  it("renaming a server to its own slug is fine", () => {
    expect(serverSlugTakenBy("GITHUB", servers, "s1")).toBeNull();
  });
});

describe("what the panel message may show", () => {
  it("only a plain code", () => {
    expect(shownCode("mac")).toBe("mac");
    expect(shownCode("invalid_grant")).toBe("invalid_grant");
    expect(shownCode("Visit https://evil.test to fix")).toBeNull();
    expect(shownCode("<b>x</b>")).toBeNull();
    expect(shownCode(undefined)).toBeNull();
  });
});
