/**
 * Kitsuden — Operations that `yield`: flows over standard SSE
 * ============================================================================
 *
 *   defineOperation({
 *     id: "import-progress", method: "GET", route: "/imports/:id/progress",
 *     output: { flow: true, schema: z.object({ facts: z.number(), total: z.number() }) },
 *     async *handle({ params }) {
 *       for await (const step of runImport(params.id)) yield step;
 *     },
 *   })
 *
 * It is served as STANDARD Server-Sent Events (`text/event-stream`), not as a
 * custom RPC protocol: any `EventSource`, `curl -N` or proxy understands it,
 * and it does not move away from MCP (which receives the list of events).
 *
 *   id: 1
 *   data: {"facts":1,"total":3}
 *
 *   event: end
 *   data: {"count":3}
 *
 * If the generator throws: `event: error` with the problem+json and it closes.
 * Each event is validated against `output.schema` (that of ONE event): an
 * event that does not match is a server failure and cuts the flow with an error.
 *
 * ── THE TRANSACTION ────────────────────────────────────────────────────────
 *
 * A flow outlasts the request: the request's RLS transaction is committed when
 * the `Response` is returned, and a later query would go to an already
 * returned connection. Each STEP of the generator (what runs between two
 * `yield`s) goes in its own short RLS transaction with whoever asks
 * (`inRlsTransaction`): `repo()` and the kon's `db` see that user, RLS
 * applies, and while the flow waits it holds no connection. What the generator
 * does in a step is committed when moving to the next one.
 */

import type { Context } from "hono";

import {
  background,
  inRlsTransaction,
  type TransactionalConnection,
  type RlsUser,
} from "./rls-request";

/** The minimum of a Zod schema needed to validate an event. */
interface EventSchema {
  safeParse(
    v: unknown
  ): { success: true; data: unknown } | { success: false; error: { message: string } };
}

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/** An event in wire format (the `data` lines are split on line breaks). */
export function sseEvent(e: SseEvent): string {
  let out = "";
  if (e.id !== undefined) out += `id: ${e.id}\n`;
  if (e.event) out += `event: ${e.event}\n`;
  for (const line of e.data.split(/\r?\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** Reads SSE events from a complete text (MCP, tests). Ignores comments (`:`). */
export function readSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const ev: SseEvent = { data: "" };
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "event") ev.event = value;
      else if (field === "id") ev.id = value;
    }
    if (data.length === 0 && !ev.event) continue;
    ev.data = data.join("\n");
    events.push(ev);
  }
  return events;
}

/** How often, at most, something goes out over a waiting flow (`: ping` comment). */
const HEARTBEAT_MS = 15_000;

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof (v as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === "function";
}

function problem(status: number, code: string, title: string, detail?: string) {
  return { type: "about:blank", title, status, code, ...(detail ? { detail } : {}) };
}

export interface FlowOptions {
  /** Where each step's transactions are opened from (the kon's `db`). */
  db: TransactionalConnection | null;
  user: RlsUser | null;
  schema: EventSchema | undefined;
  /** `kon/op`, for messages. */
  where: string;
  /** To report a failure (to the host's log). */
  onFailure?: (err: unknown) => void;
}

/**
 * The SSE `Response` of a flow. `result` is what `handle` returned.
 * It throws (before opening the stream) if it is not an `AsyncIterable`.
 */
export function flowResponse(c: Context, result: unknown, o: FlowOptions): Response {
  if (!isAsyncIterable(result)) {
    throw new Error(
      `${o.where}: output.flow requires handle to return an AsyncIterable (async function*)`
    );
  }
  const iterator = result[Symbol.asyncIterator]();
  const encode = new TextEncoder();
  let n = 0;
  let closed = false;

  // A generator step, in its short RLS transaction (see the header).
  const step = (): Promise<IteratorResult<unknown>> =>
    background(() =>
      o.db ? inRlsTransaction(o.db, o.user, () => iterator.next()) : iterator.next()
    );

  const flow = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      const send = (e: SseEvent) => controller.enqueue(encode.encode(sseEvent(e)));
      const close = () => {
        closed = true;
        controller.close();
      };
      try {
        // A step that takes a while (the generator is waiting for something) does not leave the connection
        // silent: an SSE comment every 15 s keeps it alive behind proxies that
        // cut off idle connections. `EventSource` and the SDK ignore it.
        const pending = step();
        let r: IteratorResult<unknown> | undefined;
        while (!r) {
          let clock: ReturnType<typeof setTimeout> | undefined;
          const heartbeat = new Promise<null>((ok) => {
            clock = setTimeout(() => ok(null), HEARTBEAT_MS);
          });
          const ready = await Promise.race([pending.then((x) => ({ x })), heartbeat]);
          clearTimeout(clock);
          if (ready) r = ready.x;
          else controller.enqueue(encode.encode(": ping\n\n"));
        }
        if (r.done) {
          send({ event: "end", data: JSON.stringify({ count: n }) });
          close();
          return;
        }
        let value = r.value;
        if (o.schema) {
          const v = o.schema.safeParse(value);
          if (!v.success) {
            o.onFailure?.(
              new Error(`${o.where}: event ${n + 1} does not match the schema: ${v.error.message}`)
            );
            send({
              event: "error",
              data: JSON.stringify(
                problem(
                  500,
                  "KITSUDEN_E_INTERNAL",
                  "Invalid event",
                  "An event did not match its schema."
                )
              ),
            });
            close();
            await iterator.return?.(undefined);
            return;
          }
          value = v.data;
        }
        n++;
        send({ id: String(n), data: JSON.stringify(value) });
      } catch (err) {
        o.onFailure?.(err);
        const status =
          typeof (err as { status?: unknown })?.status === "number"
            ? (err as { status: number }).status
            : 500;
        const code =
          typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : "KITSUDEN_E_INTERNAL";
        send({
          event: "error",
          data: JSON.stringify(
            status < 500
              ? problem(status, code, (err as Error).message ?? "Error")
              : problem(500, "KITSUDEN_E_INTERNAL", "Internal error")
          ),
        });
        close();
      }
    },
    async cancel() {
      // The client left: the generator is closed (its `finally` blocks run).
      closed = true;
      await background(() => iterator.return?.(undefined));
    },
  });

  return new Response(flow, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // nginx/Caddy: no buffering, each event goes out immediately.
      "x-accel-buffering": "no",
      ...(c.res?.headers.get("x-request-id")
        ? { "x-request-id": c.res.headers.get("x-request-id")! }
        : {}),
    },
  });
}
