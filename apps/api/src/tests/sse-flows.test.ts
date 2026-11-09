/**
 * Operations that `yield` against real Postgres
 * ============================================================================
 *   · Each `yield` goes out as a standard, validated SSE event; at the end, `end`.
 *   · Each step of the generator runs in its RLS transaction with the asker
 *     (RLS sees the user at every step, even though the request was already committed).
 *   · An event that does not meet the schema, or a generator that throws: `error`.
 *   · The client that disconnects: the generator closes (its `finally` runs).
 *   · OpenAPI: text/event-stream with each event's schema; MCP reads the list.
 */

import { defineOperation, type KonContext } from "@kitsuden/shared";
import { beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { readSseEvents } from "../../../../packages/engine/src/flows";
import { operationsRouter } from "../../../../packages/engine/src/operations";
import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import {
  theRequestDb,
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";
import { openApiOperation } from "../lib/operations-openapi";
import { createTestKonContext } from "../lib/test-kon-context";

import { isDatabaseAvailable } from "./setup";

let available = false;
let closedOnes = 0;
const instance = theRequestDb(db);
const Event = z.object({ step: z.number(), user: z.string() });

const progress = defineOperation({
  id: "progress",
  method: "GET",
  route: "/progress",
  summary: "Progress",
  description: "Three steps, each one reading who asks from the database.",
  access: "public",
  input: {
    query: z.object({
      until: z.coerce.number().int().min(1).max(10).default(3),
      broken: z.string().optional(),
    }),
  },
  output: { flow: true, schema: Event },
  async *handle({ query }) {
    try {
      for (let step = 1; step <= query.until; step++) {
        const r = await instance.execute(
          sql`SELECT current_setting('app.current_user_id', true) AS uid`
        );
        const uid = String((r.rows[0] as { uid: string | null }).uid ?? "");
        if (query.broken === "schema" && step === 2) yield { step: "two" } as never;
        if (query.broken === "throws" && step === 2) throw new Error("it broke");
        yield { step, user: uid };
      }
    } finally {
      closedOnes++;
    }
  },
});

const ctx = createTestKonContext({
  db: { instance: theRequestDb(db) } as unknown as KonContext["db"],
});
const app = new Hono();
app.use("*", async (c, next) => {
  const id = c.req.header("x-user");
  c.set("user" as never, (id ? { id, role: "user" } : null) as never);
  await runInRequestScope({ requestId: "sse" }, () => next());
});
app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
app.route("/demo", operationsRouter("kon-demo", [progress], ctx));

beforeAll(async () => {
  available = await isDatabaseAvailable();
});

describe("SSE flows", () => {
  it("each yield is an event with an id, and it ends with `end`", async () => {
    if (!available) return;
    const res = await app.request("/demo/progress?until=3", { headers: { "x-user": "u-sse" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = readSseEvents(await res.text());
    expect(events.map((e) => e.event ?? "message")).toEqual([
      "message",
      "message",
      "message",
      "end",
    ]);
    expect(events[0]?.id).toBe("1");
    expect(JSON.parse(events[3]!.data)).toEqual({ count: 3 });
    // Each step, in its RLS transaction with the asker (the request was already committed).
    expect(events.slice(0, 3).map((e) => JSON.parse(e.data).user)).toEqual([
      "u-sse",
      "u-sse",
      "u-sse",
    ]);
  });

  it("an event that does not meet the schema cuts off with `error` (generic 500)", async () => {
    if (!available) return;
    const res = await app.request("/demo/progress?until=3&broken=schema", {
      headers: { "x-user": "u-sse" },
    });
    const events = readSseEvents(await res.text());
    expect(events.map((e) => e.event ?? "message")).toEqual(["message", "error"]);
    expect(JSON.parse(events[1]!.data).code).toBe("KITSUDEN_E_INTERNAL");
  });

  it("a generator that throws cuts off with `error` without leaking the internal message", async () => {
    if (!available) return;
    const res = await app.request("/demo/progress?until=3&broken=throws");
    const events = readSseEvents(await res.text());
    const last = events.at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data).not.toContain("it broke");
  });

  it("if the client disconnects, the generator closes (its finally runs)", async () => {
    if (!available) return;
    const before = closedOnes;
    const res = await app.request("/demo/progress?until=10");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    // `cancel` is asynchronous: give it a moment.
    await new Promise((r) => setTimeout(r, 50));
    expect(closedOnes).toBe(before + 1);
  });

  it("OpenAPI: text/event-stream, each event's schema and the stream marker", () => {
    const { operation: operation } = openApiOperation("kon-demo", "/api/demo", progress);
    const r = (
      operation.responses as Record<string, { content?: Record<string, Record<string, unknown>> }>
    )["200"];
    const media = r?.content?.["text/event-stream"];
    expect(media?.["x-kitsuden-event-schema"]).toMatchObject({
      type: "object",
      required: ["step", "user"],
    });
    expect((operation["x-kitsuden-operation"] as { stream?: boolean }).stream).toBe(true);
  });

  it("defineOperation rejects a flow without a schema or with another status", () => {
    expect(() =>
      defineOperation({ ...progress, id: "no-schema", output: { flow: true } } as never)
    ).toThrow(/schema/);
    expect(() =>
      defineOperation({
        ...progress,
        id: "with-201",
        output: { flow: true, schema: Event, status: 201 },
      } as never)
    ).toThrow(/200/);
  });
});
