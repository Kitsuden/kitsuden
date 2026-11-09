/**
 * The MCP SSE transport on Web streams.
 *
 * The SDK's `SSEServerTransport` writes to a Node `ServerResponse`, which a Hono
 * handler on Bun does not have: it gets a Request and returns a Response. This
 * is the same protocol over a `ReadableStream`:
 *
 *   GET  <sse path>                  opens the stream; first event `endpoint`
 *                                    says where to post, with the session id
 *   POST <endpoint>?sessionId=<id>   one JSON-RPC message; the answer comes back
 *                                    on the stream as an event `message`
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** A proxy or client that sees no bytes for a while may drop the connection. */
const KEEP_ALIVE_MS = 15_000;

export class WebSseTransport implements Transport {
  readonly sessionId = crypto.randomUUID();
  /** The body of the GET response. */
  readonly stream: ReadableStream<Uint8Array>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(private readonly endpoint: string) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      // The client went away.
      cancel: () => void this.close(),
    });
  }

  async start(): Promise<void> {
    this.write(`event: endpoint\ndata: ${this.endpoint}?sessionId=${this.sessionId}\n\n`);
    this.keepAlive = setInterval(() => this.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("SSE transport is closed");
    this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    try {
      this.controller?.close();
    } catch {
      // Already closed by the client disconnecting.
    }
    this.onclose?.();
  }

  /** A POSTed message. Returns false if it is not valid JSON-RPC. */
  receive(body: unknown): boolean {
    const parsed = JSONRPCMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.onerror?.(new Error(`Invalid JSON-RPC message: ${parsed.error.message}`));
      return false;
    }
    this.onmessage?.(parsed.data);
    return true;
  }

  private write(text: string): void {
    if (this.closed) return;
    this.controller?.enqueue(this.encoder.encode(text));
  }
}
