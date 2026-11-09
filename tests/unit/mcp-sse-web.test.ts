/**
 * The standalone MCP server's SSE transport speaks the protocol over Web streams,
 * because a Hono handler has no Node response to give the SDK's transport.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { WebSseTransport } from "../../packages/mcp-server/src/sse-web";

async function readEvents(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length <= count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n\n").filter(Boolean);
}

describe("WebSseTransport", () => {
  it("announces the endpoint with its session id, then streams messages", async () => {
    const t = new WebSseTransport("/messages");
    await t.start();
    await t.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const events = await readEvents(t.stream, 2);
    expect(events[0]).toBe(`event: endpoint\ndata: /messages?sessionId=${t.sessionId}`);
    expect(events[1]).toBe(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}`);
    await t.close();
  });

  it("hands a valid POST to onmessage and refuses anything else", () => {
    const t = new WebSseTransport("/messages");
    const received: unknown[] = [];
    const errors: Error[] = [];
    t.onmessage = (m) => received.push(m);
    t.onerror = (e) => errors.push(e);

    expect(t.receive({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(true);
    expect(received).toHaveLength(1);
    expect(t.receive({ not: "json-rpc" })).toBe(false);
    expect(received).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("closing runs onclose once and stops sending", async () => {
    const t = new WebSseTransport("/messages");
    await t.start();
    let closes = 0;
    t.onclose = () => closes++;
    await t.close();
    await t.close();
    expect(closes).toBe(1);
    await expect(t.send({ jsonrpc: "2.0", id: 2, result: {} })).rejects.toThrow(/closed/);
  });

  it("a client disconnecting closes the session", async () => {
    const t = new WebSseTransport("/messages");
    await t.start();
    let closes = 0;
    t.onclose = () => closes++;
    await t.stream.cancel();
    expect(closes).toBe(1);
  });
});

describe("standalone.ts", () => {
  const text = readFileSync(
    resolve(__dirname, "../../packages/mcp-server/src/standalone.ts"),
    "utf8"
  );

  it("does not hand Hono's response to the Node-only SDK transport", () => {
    expect(text).not.toContain("SSEServerTransport");
    expect(text).not.toContain("c.res as any");
  });

  it("binds to loopback, and refuses another host without an inbound token", () => {
    expect(text).toContain('process.env.MCP_HOST || "127.0.0.1"');
    expect(text).toMatch(/!IS_LOOPBACK && AUTH_TOKEN\.length < MIN_AUTH_TOKEN_LENGTH/);
  });

  it("encodes table names in API paths", () => {
    expect(text).not.toMatch(/\/explorer\/\$\{table\}/);
    expect(text).not.toMatch(/\/explorer\/schema\/json\/\$\{table\}/);
  });
});
