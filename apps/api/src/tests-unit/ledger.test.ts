/**
 * Agent data ledger — the pure part (lib/ledger.ts)
 * ============================================================================
 * Evidence validation, what a proposal writes, the per-field diff, the
 * reviewer's decisions and the body that is really executed. No database: the
 * module's `db` is replaced (the integration test is
 * src/tests/agent-data-ledger.test.ts).
 */

import { describe, expect, it, mock } from "bun:test";

mock.module("../db", () => ({ db: {} }));

const {
  LedgerInputError,
  applyDecisions,
  checkEvidenceFields,
  computeFieldDiff,
  parseEvidence,
  prepareDirectEvidence,
  proposedFields,
  recordTarget,
  resolveDecisions,
  reviewDate,
  rowIdFromResult,
  splitEvidence,
} = await import("../lib/ledger");

const DS = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";

describe("evidence", () => {
  it("accepts the documented shape and normalises it", () => {
    const [e] = parseEvidence([
      {
        field: " data.price ",
        source: "https://x.example/p",
        excerpt: "49 per month",
        confidence: 0.5,
        retrievedAt: "2026-11-01",
      },
    ]);
    expect(e).toEqual({
      field: "data.price",
      source: "https://x.example/p",
      quote: "49 per month",
      confidence: 0.5,
      retrievedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(parseEvidence(undefined)).toEqual([]);
  });

  it("refuses what an agent can fix, saying what", () => {
    const bad: Array<[unknown, string]> = [
      [{ field: "a", source: "s" }, "must be an array"],
      [[{ source: "s" }], ".field"],
      [[{ field: "a" }], ".source"],
      [[{ field: "a", source: "s", confidence: 2 }], "confidence"],
      [[{ field: "a", source: "s", retrievedAt: "yesterday" }], "retrievedAt"],
      [[{ field: "a", source: "s", quote: 5 }], "quote"],
    ];
    for (const [raw, word] of bad) {
      expect(() => parseEvidence(raw)).toThrow(word);
      expect(() => parseEvidence(raw)).toThrow(LedgerInputError);
    }
  });

  it("is taken out of the body (REST) and out of an SDK tool's body argument (MCP)", () => {
    expect(splitEvidence("rest", { data: { a: 1 }, _evidence: [1] })).toEqual({
      body: { data: { a: 1 } },
      raw: [1],
    });
    expect(splitEvidence("mcp", { id: "x", body: { a: 1, _evidence: [2] } })).toEqual({
      body: { id: "x", body: { a: 1 } },
      raw: [2],
    });
    expect(splitEvidence("rest", [1, 2])).toEqual({ body: [1, 2], raw: undefined });
  });
});

describe("what a proposal writes", () => {
  it("dataset entries over REST; a bulk array or a DELETE is not a record", async () => {
    const patch = await recordTarget({
      channel: "rest",
      method: "PATCH",
      path: `/api/datasets/${DS}/entries/${ROW}?x=1`,
      body: { data: {} },
    });
    expect(patch).toMatchObject({
      kind: "update",
      shape: "entry",
      entity: "dataset_entry",
      rowId: ROW,
      replacesData: true,
    });
    const post = await recordTarget({
      channel: "rest",
      method: "POST",
      path: `/api/datasets/${DS}/entries`,
      body: { title: "t" },
    });
    expect(post).toMatchObject({ kind: "create", shape: "entry", rowId: null });
    expect(
      await recordTarget({
        channel: "rest",
        method: "POST",
        path: `/api/datasets/${DS}/entries`,
        body: [{ title: "t" }],
      })
    ).toBeNull();
    expect(
      await recordTarget({
        channel: "rest",
        method: "DELETE",
        path: `/api/datasets/${DS}/entries/${ROW}`,
        konId: "kon-datasets",
        body: null,
      })
    ).toBeNull();
  });

  it("any kon SDK operation with a JSON body; a legacy route is decided whole", async () => {
    expect(
      await recordTarget({
        channel: "rest",
        method: "POST",
        path: "/api/crm/contacts",
        konId: "kon-crm",
        body: { name: "a" },
      })
    ).toMatchObject({ kind: "create", shape: "body", entity: "sdk:kon-crm" });
    expect(
      await recordTarget({
        channel: "mcp",
        method: "PATCH",
        path: "/api/crm/contacts/1",
        konId: "kon-crm",
        tool: "crm_update_contact",
        body: { id: "1", body: { name: "b" } },
      })
    ).toMatchObject({
      kind: "update",
      shape: "body",
      inArgs: true,
      readPath: "/api/crm/contacts/1",
    });
    expect(
      await recordTarget({ channel: "rest", method: "POST", path: "/api/legacy", body: { a: 1 } })
    ).toBeNull();
  });

  it("lists the fields of each shape", async () => {
    const entry = (await recordTarget({
      channel: "rest",
      method: "POST",
      path: `/api/datasets/${DS}/entries`,
      body: {},
    }))!;
    expect([
      ...proposedFields(entry, { title: "t", data: { a: 1, b: 2 }, other: 1 }).keys(),
    ]).toEqual(["title", "data.a", "data.b"]);
    const mcp = { kind: "update" as const, shape: "mcp-record" as const, entity: null, rowId: "r" };
    expect([
      ...proposedFields(mcp, { collection: "c", id: "r", data: { a: 1 }, status: "draft" }).keys(),
    ]).toEqual(["data.a", "status"]);
  });
});

const entryUpdate = {
  kind: "update" as const,
  shape: "entry" as const,
  entity: "dataset_entry",
  rowId: ROW,
  replacesData: true,
  readPath: `/api/datasets/${DS}/entries/${ROW}`,
};

describe("the per-field diff", () => {
  it("changed, added and removed keys; unchanged ones are left out", () => {
    const d = computeFieldDiff(
      entryUpdate,
      { title: "Same", data: { a: 1, b: 3, c: 4 } },
      { title: "Same", data: { a: 1, b: 2, gone: true } }
    );
    expect(d.fields).toEqual([
      { field: "data.b", before: 2, after: 3, change: "update" },
      { field: "data.c", after: 4, change: "add" },
      { field: "data.gone", before: true, change: "remove" },
    ]);
  });

  it("without the current row every field counts, and it says why", () => {
    const d = computeFieldDiff(entryUpdate, { data: { a: 1 } }, null, 403);
    expect(d.fields).toEqual([{ field: "data.a", after: 1, change: "update" }]);
    expect(d.currentUnavailable).toBe(403);
  });

  it("evidence must name a proposed field", () => {
    expect(() =>
      checkEvidenceFields(entryUpdate, { data: { a: 1 } }, [
        { field: "data.b", source: "s", quote: null, confidence: null, retrievedAt: null },
      ])
    ).toThrow("data.b");
  });
});

describe("decisions and the executed body", () => {
  const diff = computeFieldDiff(
    entryUpdate,
    { title: "New", data: { a: 1, b: 3 } },
    { title: "Old", data: { a: 0, b: 2, gone: 1 } }
  );

  it("unlisted fields are rejected; an empty list, unknown, repeated or secret ones are refused", () => {
    const all = resolveDecisions(diff, [{ field: "data.b", decision: "accept" }]);
    expect(all.map((d) => [d.field, d.decision])).toEqual([
      ["title", "reject"],
      ["data.a", "reject"],
      ["data.b", "accept"],
      ["data.gone", "reject"],
    ]);
    expect(() => resolveDecisions(diff, [])).toThrow("fields is empty");
    expect(() => resolveDecisions(diff, [{ field: "x", decision: "accept" }])).toThrow(
      "not a field"
    );
    expect(() =>
      resolveDecisions(diff, [
        { field: "title", decision: "accept" },
        { field: "title", decision: "reject" },
      ])
    ).toThrow("twice");
    expect(() =>
      resolveDecisions(diff, [
        { field: "title", decision: "accept", value: { password: "hunter2hunter2" } },
      ])
    ).toThrow("secret");
  });

  it("the entry PATCH applies the accepted fields over the row as it is NOW", () => {
    const decisions = resolveDecisions(diff, [
      { field: "title", decision: "reject" },
      { field: "data.a", decision: "accept", value: 9 },
      { field: "data.b", decision: "accept" },
      { field: "data.gone", decision: "reject" },
    ]);
    const now = { title: "Changed meanwhile", data: { a: 0, b: 2, gone: 1, added: "by someone" } };
    expect(applyDecisions(diff, { title: "New", data: { a: 1, b: 3 } }, decisions, now)).toEqual({
      data: { a: 9, b: 3, gone: 1, added: "by someone" },
    });
    // An accepted removal removes.
    const rm = resolveDecisions(
      diff,
      diff.fields.map((f) => ({ field: f.field, decision: "accept" as const }))
    );
    expect(
      (applyDecisions(diff, { title: "New", data: { a: 1, b: 3 } }, rm, now) as { data: object })
        .data
    ).toEqual({ a: 1, b: 3, added: "by someone" });
    // Without the current row it cannot be applied.
    expect(() => applyDecisions(diff, { data: { a: 1 } }, decisions, null)).toThrow(
      "current_unavailable"
    );
  });

  it("a create drops the rejected fields; an MCP update sends only the accepted keys", () => {
    const create = {
      kind: "create" as const,
      shape: "entry" as const,
      entity: "dataset_entry",
      rowId: null,
    };
    const cd = computeFieldDiff(create, { title: "T", data: { a: 1, b: 2 } }, null);
    expect(
      applyDecisions(
        cd,
        { title: "T", data: { a: 1, b: 2 } },
        resolveDecisions(cd, [
          { field: "title", decision: "accept" },
          { field: "data.a", decision: "accept" },
          { field: "data.b", decision: "reject" },
        ]),
        null
      )
    ).toEqual({ title: "T", data: { a: 1 } });

    const mcp = {
      kind: "update" as const,
      shape: "mcp-record" as const,
      entity: "dataset_entry",
      rowId: ROW,
    };
    const args = { collection: "c", id: ROW, data: { a: 1, b: 2 }, status: "draft" };
    const md = computeFieldDiff(mcp, args, null);
    expect(
      applyDecisions(
        md,
        args,
        resolveDecisions(md, [
          { field: "data.a", decision: "reject" },
          { field: "data.b", decision: "accept" },
          { field: "status", decision: "reject" },
        ]),
        null
      )
    ).toEqual({ collection: "c", id: ROW, data: { b: 2 } });
  });

  it("a kon SDK tool over MCP: the record is its `body` argument", () => {
    const t = {
      kind: "create" as const,
      shape: "body" as const,
      entity: "sdk:kon-crm",
      rowId: null,
      inArgs: true,
    };
    const args = { body: { name: "a", email: "e" } };
    const d = computeFieldDiff(t, args, null);
    expect(
      applyDecisions(
        d,
        args,
        resolveDecisions(d, [
          { field: "name", decision: "accept" },
          { field: "email", decision: "reject" },
        ]),
        null
      )
    ).toEqual({ body: { name: "a" } });
  });
});

describe("the row id of the result and the review date", () => {
  it("reads it from a REST body or an MCP result", () => {
    const create = {
      kind: "create" as const,
      shape: "entry" as const,
      entity: "dataset_entry",
      rowId: null,
    };
    expect(rowIdFromResult(create, { id: ROW })).toBe(ROW);
    expect(
      rowIdFromResult(create, {
        content: [{ type: "text", text: `Created dataset record: ${ROW}` }],
      })
    ).toBe(ROW);
    expect(rowIdFromResult({ ...create, rowId: "known" }, null)).toBe("known");
    expect(rowIdFromResult(create, { ok: true })).toBeNull();
  });

  it("a review is in the future and within a year", () => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    expect(reviewDate("2026-11-11T00:00:00Z", now).toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(() => reviewDate("2026-11-01T00:00:00Z", now)).toThrow("future");
    expect(() => reviewDate("2028-01-01T00:00:00Z", now)).toThrow("within");
    expect(() => reviewDate("soon", now)).toThrow("ISO");
  });
});

describe("evidence of a write that is not held (direct mode)", () => {
  const path = `/api/datasets/${DS}/entries`;
  it("takes `_evidence` out of a record write and keeps it for the row", async () => {
    const r = await prepareDirectEvidence({
      channel: "rest",
      method: "POST",
      path,
      body: { title: "A", data: { price: 3 }, _evidence: [{ field: "data.price", source: "s" }] },
    });
    expect(r.stripped).toBe(true);
    expect(r.body).toEqual({ title: "A", data: { price: 3 } });
    expect(r.pending?.target.kind).toBe("create");
    expect(r.pending?.evidence.map((e) => e.field)).toEqual(["data.price"]);
  });

  it("an empty list is stripped and keeps nothing", async () => {
    const r = await prepareDirectEvidence({
      channel: "rest",
      method: "POST",
      path,
      body: { data: { price: 3 }, _evidence: [] },
    });
    expect(r.stripped).toBe(true);
    expect(r.pending).toBeNull();
  });

  it("leaves untouched what has no `_evidence` or does not write a record", async () => {
    const body = { data: { price: 3 } };
    expect(await prepareDirectEvidence({ channel: "rest", method: "POST", path, body })).toEqual({
      body,
      stripped: false,
      pending: null,
    });
    const legacy = { name: "x", _evidence: [{ field: "name", source: "s" }] };
    const r = await prepareDirectEvidence({
      channel: "rest",
      method: "POST",
      path: "/api/legacy-thing",
      body: legacy,
    });
    expect(r.stripped).toBe(false);
    expect(r.body).toBe(legacy);
  });

  it("refuses evidence that is invalid or names a field the write does not have", async () => {
    await expect(
      prepareDirectEvidence({
        channel: "rest",
        method: "POST",
        path,
        body: { data: { price: 3 }, _evidence: [{ field: "data.price" }] },
      })
    ).rejects.toBeInstanceOf(LedgerInputError);
    await expect(
      prepareDirectEvidence({
        channel: "rest",
        method: "POST",
        path,
        body: { data: { price: 3 }, _evidence: [{ field: "data.prize", source: "s" }] },
      })
    ).rejects.toThrow("not a field");
  });
});
