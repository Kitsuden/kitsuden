/**
 * The contracts kons and the core share: event names, link relations, rule
 * conditions and templates, aggregate queries, entity declarations.
 *
 * All of it is pure (packages/shared), so what is tested here is the part a
 * mistake would make silent: a condition that reads a prototype, a template
 * that turns a number into text, a query whose shape passes with a field that
 * is not a name, a symmetric link stored twice.
 */

import { PGlite } from "@electric-sql/pglite";
import { link, neighbors } from "@kitsuden/engine";
import {
  aggregateQueryProblem,
  buildKonEventCatalog,
  canonicalEnds,
  conditionsProblem,
  dimensionAlias,
  evaluateCondition,
  evaluateConditions,
  fillTemplate,
  isKonEventName,
  isSealedSecret,
  isSymmetricRelation,
  konEntityProblem,
  konEventsProblem,
  LINK_RELATIONS,
  measureAlias,
  readPath,
  reportDefinitionProblem,
  ruleConfigProblem,
  type KonEventsDeclaration,
} from "@kitsuden/shared";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readSqlFile } from "../../apps/api/src/lib/sql-file";

describe("kon events", () => {
  it("accepts the recommended shape and the names already in use", () => {
    for (const name of [
      "crm:deal.won",
      "shop:order.paid",
      "crm:deal:stage-changed",
      "payment:subscription.payment_succeeded",
    ]) {
      expect(isKonEventName(name)).toBe(true);
    }
    for (const name of ["deal.won", "CRM:deal.won", "crm:", ":deal", "crm:deal won", 5, null]) {
      expect(isKonEventName(name)).toBe(false);
    }
  });

  it("refuses a declaration with a malformed name or no description", () => {
    expect(konEventsProblem(undefined)).toBeNull();
    expect(
      konEventsProblem({ emits: { "crm:deal.won": { description: "A deal was won." } } })
    ).toBeNull();
    expect(konEventsProblem({ emits: { "deal won": { description: "x" } } })).toContain("deal won");
    expect(konEventsProblem({ emits: { "crm:deal.won": { description: " " } } })).toContain(
      "description"
    );
    expect(konEventsProblem({ listens: ["nope"] })).toContain("nope");
  });

  it("builds a catalog that says who emits and who listens", () => {
    const catalog = buildKonEventCatalog(
      new Map<string, KonEventsDeclaration>([
        [
          "kon-ecommerce",
          {
            emits: {
              "shop:order.paid": {
                description: "An order was paid.",
                payload: { orderId: "uuid" },
              },
            },
          },
        ],
        [
          "kon-crm",
          {
            emits: { "crm:deal.won": { description: "A deal was won." } },
            listens: ["shop:order.paid"],
          },
        ],
        ["kon-newsletter", { listens: ["shop:order.paid", "other:thing.happened"] }],
      ])
    );
    expect(catalog.map((e) => e.name)).toEqual(["crm:deal.won", "shop:order.paid"]);
    const paid = catalog.find((e) => e.name === "shop:order.paid");
    expect(paid?.source).toBe("kon-ecommerce");
    expect(paid?.listeners).toEqual(["kon-crm", "kon-newsletter"]);
    expect(paid?.payload).toEqual({ orderId: "uuid" });
  });
});

describe("rule conditions", () => {
  const data = {
    deal: { amount: 500, stage: "won", tags: ["vip", "eu"] },
    status: "open",
    count: "12",
    empty: null,
  };

  it("reads dot paths and never inherited properties", () => {
    expect(readPath(data, "deal.amount")).toBe(500);
    expect(readPath(data, "deal.missing")).toBeUndefined();
    expect(readPath(data, "__proto__.polluted")).toBeUndefined();
    expect(readPath(data, "constructor")).toBeUndefined();
    expect(readPath(data, "deal.toString")).toBeUndefined();
    expect(readPath(data, "deal..amount")).toBeUndefined();
  });

  it("compares numbers as numbers even when one arrived as text", () => {
    expect(evaluateCondition({ field: "deal.amount", op: "gt", value: 100 }, data)).toBe(true);
    expect(evaluateCondition({ field: "deal.amount", op: "gt", value: "1000" }, data)).toBe(false);
    expect(evaluateCondition({ field: "count", op: "gte", value: 12 }, data)).toBe(true);
    // "12" < "9" as text, but 12 > 9 as the amounts they are
    expect(evaluateCondition({ field: "count", op: "gt", value: "9" }, data)).toBe(true);
    expect(evaluateCondition({ field: "deal.amount", op: "eq", value: "500" }, data)).toBe(true);
  });

  it("an ordering against something that does not compare is false, not an error", () => {
    expect(evaluateCondition({ field: "deal.tags", op: "gt", value: 1 }, data)).toBe(false);
    expect(evaluateCondition({ field: "missing", op: "lt", value: 1 }, data)).toBe(false);
  });

  it("contains, starts_with, in and exists", () => {
    expect(evaluateCondition({ field: "deal.tags", op: "contains", value: "vip" }, data)).toBe(
      true
    );
    expect(evaluateCondition({ field: "status", op: "contains", value: "PE" }, data)).toBe(true);
    expect(evaluateCondition({ field: "status", op: "starts_with", value: "op" }, data)).toBe(true);
    expect(evaluateCondition({ field: "status", op: "in", value: ["open", "won"] }, data)).toBe(
      true
    );
    expect(evaluateCondition({ field: "status", op: "in", value: ["lost"] }, data)).toBe(false);
    expect(evaluateCondition({ field: "status", op: "exists" }, data)).toBe(true);
    expect(evaluateCondition({ field: "empty", op: "exists" }, data)).toBe(false);
    expect(evaluateCondition({ field: "empty", op: "exists", value: false }, data)).toBe(true);
    expect(evaluateCondition({ field: "status", op: "neq", value: "won" }, data)).toBe(true);
  });

  it("all needs every condition, any needs one, none always passes", () => {
    const conditions = [
      { field: "status", op: "eq" as const, value: "open" },
      { field: "deal.amount", op: "gt" as const, value: 1000 },
    ];
    expect(evaluateConditions(conditions, data).passed).toBe(false);
    expect(evaluateConditions(conditions, data, "any").passed).toBe(true);
    expect(evaluateConditions([], data).passed).toBe(true);
    expect(evaluateConditions(undefined, data).passed).toBe(true);
    const outcomes = evaluateConditions(conditions, data).outcomes;
    expect(outcomes.map((o) => o.passed)).toEqual([true, false]);
    expect(outcomes[1].actual).toBe(500);
  });

  it("says what is wrong with conditions that cannot be stored", () => {
    expect(conditionsProblem(undefined)).toBeNull();
    expect(conditionsProblem([{ field: "a.b", op: "eq", value: 1 }], "any")).toBeNull();
    expect(conditionsProblem([{ field: "a.b", op: "eq", value: 1 }], "some")).toContain("match");
    expect(conditionsProblem({})).toContain("list");
    expect(conditionsProblem([{ field: "__proto__.x", op: "eq", value: 1 }])).toContain("field");
    expect(conditionsProblem([{ field: "a b", op: "eq", value: 1 }])).toContain("field");
    expect(conditionsProblem([{ field: "a", op: "like", value: 1 }])).toContain("op");
    expect(conditionsProblem([{ field: "a", op: "in", value: "x" }])).toContain("list");
    expect(conditionsProblem([{ field: "a", op: "eq" }])).toContain("value");
    expect(conditionsProblem([{ field: "a", op: "exists" }])).toBeNull();
    expect(
      conditionsProblem(Array.from({ length: 21 }, () => ({ field: "a", op: "exists" })))
    ).toContain("20");
  });
});

describe("rule templates", () => {
  const scope = {
    event: { dealId: "d1", amount: 500, contact: { name: "Ana" } },
    rule: { name: "R" },
  };

  it("a string that is only a placeholder keeps the type it points to", () => {
    expect(fillTemplate("{{event.amount}}", scope)).toBe(500);
    expect(fillTemplate("{{ event.contact }}", scope)).toEqual({ name: "Ana" });
    expect(fillTemplate("{{event.missing}}", scope)).toBeNull();
  });

  it("an embedded placeholder becomes text, and a missing one an empty string", () => {
    expect(fillTemplate("Deal {{event.dealId}} for {{event.contact.name}}", scope)).toBe(
      "Deal d1 for Ana"
    );
    expect(fillTemplate("Total: {{event.amount}} / {{event.nope}}", scope)).toBe("Total: 500 / ");
  });

  it("walks objects and lists, and drops keys that reach the object machinery", () => {
    const filled = fillTemplate(
      {
        to: "{{event.contact.name}}",
        list: ["{{event.amount}}", 2],
        nested: { id: "{{event.dealId}}" },
        n: 7,
      },
      scope
    );
    expect(filled).toEqual({ to: "Ana", list: [500, 2], nested: { id: "d1" }, n: 7 });
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": "{{event.dealId}}"}');
    const out = fillTemplate(hostile, scope) as Record<string, unknown>;
    expect(out.ok).toBe("d1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
  });

  it("a placeholder cannot read outside the scope", () => {
    expect(fillTemplate("{{constructor.name}}", scope)).toBeNull();
    expect(fillTemplate("x{{__proto__.y}}", scope)).toBe("x");
  });
});

describe("rule config", () => {
  it("needs steps, each with a well-formed handler", () => {
    expect(ruleConfigProblem({})).toContain("at least one step");
    expect(ruleConfigProblem({ steps: [] })).toContain("at least one step");
    expect(
      ruleConfigProblem({ steps: [{ handler: "core:webhook", config: { url: "https://x" } }] })
    ).toBeNull();
    expect(ruleConfigProblem({ steps: [{ handler: "webhook" }] })).toContain("handler");
    expect(ruleConfigProblem({ steps: [{ handler: "core:webhook", config: [] }] })).toContain(
      "config"
    );
    expect(
      ruleConfigProblem({ steps: [{ handler: "core:webhook", continueOnError: "yes" }] })
    ).toContain("continueOnError");
    expect(
      ruleConfigProblem({ steps: Array.from({ length: 21 }, () => ({ handler: "core:webhook" })) })
    ).toContain("20");
  });
});

describe("aggregate queries", () => {
  const base = { source: { table: "crm_deals" }, measures: [{ fn: "count" }] };

  it("accepts a well-formed query", () => {
    expect(aggregateQueryProblem(base)).toBeNull();
    expect(
      aggregateQueryProblem({
        source: { dataset: "crm-vehicle" },
        measures: [{ fn: "sum", field: "amount", as: "total" }, { fn: "count" }],
        groupBy: [{ field: "closed_at", bucket: "month", as: "month" }],
        filters: [
          { field: "status", op: "in", value: ["won", "lost"] },
          { field: "owner_id", op: "is_null", value: false },
        ],
        orderBy: [{ by: "month", dir: "desc" }],
        limit: 12,
      })
    ).toBeNull();
  });

  it("refuses anything that is not a plain name where an identifier goes", () => {
    for (const field of ["amount; DROP TABLE x", "a.b", 'a"b', "a b", "", "1abc"]) {
      expect(aggregateQueryProblem({ ...base, measures: [{ fn: "sum", field }] })).not.toBeNull();
      expect(aggregateQueryProblem({ ...base, groupBy: [{ field }] })).not.toBeNull();
      expect(
        aggregateQueryProblem({ ...base, filters: [{ field, op: "eq", value: 1 }] })
      ).not.toBeNull();
    }
    expect(aggregateQueryProblem({ ...base, source: { table: "x; DROP" } })).toContain(
      "source.table"
    );
    expect(aggregateQueryProblem({ ...base, measures: [{ fn: "count", as: "a b" }] })).toContain(
      "as"
    );
  });

  it("refuses a source that is both or neither, unknown functions and buckets, and bad limits", () => {
    expect(aggregateQueryProblem({ ...base, source: {} })).toContain("exactly one");
    expect(aggregateQueryProblem({ ...base, source: { table: "a", dataset: "b" } })).toContain(
      "exactly one"
    );
    expect(aggregateQueryProblem({ ...base, measures: [] })).toContain("at least one measure");
    expect(aggregateQueryProblem({ ...base, measures: [{ fn: "median", field: "x" }] })).toContain(
      "fn"
    );
    expect(aggregateQueryProblem({ ...base, measures: [{ fn: "sum" }] })).toContain(
      "needs a field"
    );
    expect(aggregateQueryProblem({ ...base, groupBy: [{ field: "d", bucket: "hour" }] })).toContain(
      "bucket"
    );
    expect(aggregateQueryProblem({ ...base, limit: 0 })).toContain("limit");
    expect(aggregateQueryProblem({ ...base, limit: 5000 })).toContain("limit");
    expect(
      aggregateQueryProblem({ ...base, filters: [{ field: "a", op: "eq", value: { $gt: 1 } }] })
    ).toContain("value");
    expect(
      aggregateQueryProblem({ ...base, filters: [{ field: "a", op: "in", value: [] }] })
    ).toContain("in");
  });

  it("orders only by a column of its own result, and names each column once", () => {
    expect(aggregateQueryProblem({ ...base, orderBy: [{ by: "count" }] })).toBeNull();
    expect(aggregateQueryProblem({ ...base, orderBy: [{ by: "amount" }] })).toContain(
      "not a measure or dimension"
    );
    expect(
      aggregateQueryProblem({ ...base, orderBy: [{ by: "count", dir: "sideways" }] })
    ).toContain("dir");
    expect(
      aggregateQueryProblem({ ...base, measures: [{ fn: "count" }, { fn: "count" }] })
    ).toContain("twice");
    expect(measureAlias({ fn: "sum", field: "amount" })).toBe("sum_amount");
    expect(measureAlias({ fn: "count" })).toBe("count");
    expect(dimensionAlias({ field: "closed_at", bucket: "month" })).toBe("closed_at_month");
  });

  it("checks a kon's report definition", () => {
    expect(
      reportDefinitionProblem({ id: "won-per-month", name: "Won per month", query: base })
    ).toBeNull();
    expect(reportDefinitionProblem({ id: "Won", name: "x", query: base })).toContain("id");
    expect(reportDefinitionProblem({ id: "a", name: "", query: base })).toContain("name");
    expect(
      reportDefinitionProblem({ id: "a", name: "x", query: { ...base, measures: [] } })
    ).toContain("measure");
    expect(
      reportDefinitionProblem({ id: "a", name: "x", query: base, chart: { type: "pie" } })
    ).toContain("chart.type");
    expect(
      reportDefinitionProblem({
        id: "a",
        name: "x",
        query: base,
        chart: { type: "bar", x: "count", y: ["count"] },
      })
    ).toBeNull();
  });
});

describe("kon entities and sealed secrets", () => {
  it("checks an entity declaration", () => {
    const ok = {
      slug: "crm-vehicle",
      name: "Vehicle",
      fields: [{ key: "plate", type: "text", required: true }],
    };
    expect(konEntityProblem(ok)).toBeNull();
    expect(konEntityProblem({ ...ok, slug: "Vehicle" })).toContain("slug");
    expect(konEntityProblem({ ...ok, name: "" })).toContain("name");
    expect(konEntityProblem({ ...ok, fields: [{ key: "a b", type: "text" }] })).toContain("a b");
    expect(
      konEntityProblem({
        ...ok,
        fields: [
          { key: "a", type: "text" },
          { key: "a", type: "text" },
        ],
      })
    ).toContain("twice");
    expect(konEntityProblem({ ...ok, fields: [{ key: "a", type: "" }] })).toContain("type");
    expect(konEntityProblem({ ...ok, access: { read: "everyone" } })).toContain("access.read");
  });

  it("recognises a sealed secret by its shape", () => {
    expect(
      isSealedSecret({ v: 1, kon: "kon-x", valueEncrypted: "aa", iv: "bb", authTag: "cc" })
    ).toBe(true);
    expect(isSealedSecret({ valueEncrypted: "aa", iv: "bb", authTag: "cc" })).toBe(false);
    expect(
      isSealedSecret({ v: 2, kon: "kon-x", valueEncrypted: "aa", iv: "bb", authTag: "cc" })
    ).toBe(false);
    expect(isSealedSecret("token")).toBe(false);
    expect(isSealedSecret(null)).toBe(false);
  });
});

describe("link relations", () => {
  it("publishes the common relations with a direction", () => {
    expect(Object.keys(LINK_RELATIONS).sort()).toEqual([
      "about",
      "ordered_by",
      "paid_by",
      "related",
      "same_person",
    ]);
    expect(isSymmetricRelation("same_person")).toBe(true);
    expect(isSymmetricRelation("related")).toBe(true);
    expect(isSymmetricRelation("ordered_by")).toBe(false);
    expect(isSymmetricRelation("invented_by_a_kon")).toBe(false);
  });

  it("orders the two ends the same way whoever comes first", () => {
    const a = { type: "crm_contacts", id: "2" };
    const b = { type: "nl_members", id: "1" };
    expect(canonicalEnds(a, b)).toEqual([a, b]);
    expect(canonicalEnds(b, a)).toEqual([a, b]);
    const c = { type: "crm_contacts", id: "1" };
    expect(canonicalEnds(a, c)).toEqual([c, a]);
  });

  describe("in the links table", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any;
    const contact = { type: "crm_contacts", id: "c1" };
    const member = { type: "nl_members", id: "m1" };
    const order = { type: "shop_orders", id: "o1" };

    beforeAll(async () => {
      const client = await PGlite.create();
      db = drizzle(client);
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const route = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../apps/api/src/db/migrations/0032_links.sql"
      );
      for (const stmt of readSqlFile(route, "0032").statements) await client.exec(stmt);
    });

    beforeEach(async () => {
      await db.execute("DELETE FROM kitsuden_links");
    });

    it("a symmetric relation written from both sides is ONE row", async () => {
      await link(contact, member, { relation: "same_person" }, db);
      await link(member, contact, { relation: "same_person" }, db);
      expect(await neighbors(contact, { relation: "same_person" }, db)).toHaveLength(1);
      expect(await neighbors(member, { relation: "same_person" }, db)).toHaveLength(1);
      expect((await neighbors(member, {}, db))[0]).toMatchObject({
        type: "crm_contacts",
        id: "c1",
      });
    });

    it("a directed relation keeps the direction it was written with", async () => {
      await link(order, contact, { relation: "ordered_by" }, db);
      const rows = await db.execute("SELECT from_type, to_type FROM kitsuden_links");
      const row = (rows.rows ?? rows)[0];
      expect(row.from_type).toBe("shop_orders");
      expect(row.to_type).toBe("crm_contacts");
    });

    it("refuses a relation that is not a plain name", async () => {
      await expect(link(order, contact, { relation: "Ordered By" }, db)).rejects.toThrow(
        /relation/
      );
      await expect(link(order, contact, { relation: "x'; --" }, db)).rejects.toThrow(/relation/);
    });
  });
});
