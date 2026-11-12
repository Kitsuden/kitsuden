/**
 * The logic of the list template and the record page, apart from their markup: the state
 * kept in the URL, the filters generated from a model, the query each API understands,
 * saved views, previous / next, the CSV export and the history mapped from what the API
 * keeps about a record.
 */
import { describe, expect, it } from "vitest";

import { toCsv } from "./csv";
import {
  changeFields,
  diffRecords,
  historyLine,
  proposalChanges,
  proposalTargets,
  recordHistory,
  type ProposalLike,
} from "./history";
import {
  dateRangeOf,
  filtersFromFields,
  MAX_FILTER_OPTIONS,
  type ListField,
} from "./model-filters";
import { neighboursOf, rememberNeighbours } from "./neighbours";
import { recordTitle } from "./record-title";
import { browserViewStore, currentView } from "./saved-views";
import {
  datasetSearchParams,
  explorerParams,
  fieldFromJsonSchema,
  fieldsFromDataset,
  fieldsFromRows,
  filterRows,
  formFieldsFrom,
  legacyParams,
  memorySource,
  modelParams,
  sortRows,
  type ListQuery,
} from "./source";
import {
  hasFilters,
  listStateQuery,
  readListState,
  withListState,
  type FilterShape,
  type ListState,
} from "./url-state";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

const SHAPES: FilterShape[] = [
  { key: "status", type: "select" },
  { key: "featured", type: "boolean" },
  { key: "created_at", type: "date" },
];

describe("list state in the URL", () => {
  const read = (query: string, defaults = {}) =>
    readListState(new URLSearchParams(query), SHAPES, defaults);

  it("a plain address is the default state", () => {
    expect(read("")).toEqual({
      filters: {},
      sort: null,
      page: 1,
      density: "comfortable",
      columns: null,
    });
  });

  it("reads search, filters, sort, page, density and columns", () => {
    const state = read(
      "q=ana&f.status=draft&f.featured=true&sort=-updated_at&page=3&density=compact&cols=name,status"
    );
    expect(state).toEqual({
      filters: { q: "ana", status: "draft", featured: true },
      sort: { key: "updated_at", direction: "desc" },
      page: 3,
      density: "compact",
      columns: ["name", "status"],
    });
  });

  it("ignores what it does not own or cannot read", () => {
    const state = read("tab=x&f.unknown=1&f.featured=maybe&page=-2&sort=name;drop&density=huge");
    expect(state.filters).toEqual({});
    expect(state.page).toBe(1);
    expect(state.sort).toBeNull();
    expect(state.density).toBe("comfortable");
  });

  it("a field called `page` or `sort` does not collide with the list's own parameters", () => {
    const state = readListState(new URLSearchParams("f.page=home&page=2"), [
      { key: "page", type: "select" },
    ]);
    expect(state.filters).toEqual({ page: "home" });
    expect(state.page).toBe(2);
  });

  it("writes only what differs from the defaults, in a stable order", () => {
    const state: ListState = {
      filters: { status: "draft", q: " ana ", featured: false },
      sort: { key: "name", direction: "asc" },
      page: 2,
      density: "compact",
      columns: ["name"],
    };
    expect(listStateQuery(state)).toBe(
      "q=ana&f.featured=false&f.status=draft&sort=name&page=2&density=compact&cols=name"
    );
    expect(listStateQuery(read(""))).toBe("");
  });

  it("round-trips, and the default sort is not written", () => {
    const defaults = { sort: { key: "created_at", direction: "desc" as const } };
    const query = "q=x&f.status=live&sort=-name&page=4";
    expect(listStateQuery(read(query, defaults), defaults)).toBe(query);
    expect(read("", defaults).sort).toEqual(defaults.sort);
    expect(listStateQuery(read("", defaults), defaults)).toBe("");
    // Removing a default sort is a state too.
    expect(listStateQuery({ ...read("", defaults), sort: null }, defaults)).toBe("sort=");
    expect(read("sort=", defaults).sort).toBeNull();
  });

  it("a saved view leaves the page out", () => {
    expect(listStateQuery(read("f.status=draft&page=5"), {}, { page: false })).toBe(
      "f.status=draft"
    );
  });

  it("keeps the parameters of the page around it", () => {
    const url = new URL("https://x.test/g/kon/view?tab=a&f.status=old&page=9#top");
    const next = withListState(url, { ...read(""), filters: { status: "new" } });
    expect(next).toBe("/g/kon/view?tab=a&f.status=new#top");
  });

  it("hasFilters tells no-results from empty", () => {
    expect(hasFilters(read("page=2&density=compact"))).toBe(false);
    expect(hasFilters(read("q=a"))).toBe(true);
    expect(hasFilters(read("f.featured=false"))).toBe(true);
  });
});

const FIELDS: ListField[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "status", label: "Status", kind: "select", options: [{ value: "a", label: "A" }] },
  { key: "active", label: "Active", kind: "boolean" },
  { key: "created_at", label: "Created", kind: "datetime" },
  { key: "owner_id", label: "Owner", kind: "relation", options: [{ value: "1", label: "Ana" }] },
  { key: "team_id", label: "Team", kind: "relation" },
  { key: "notes", label: "Notes", kind: "longtext" },
  { key: "secret", label: "Secret", kind: "boolean", filterable: false },
];

describe("filters generated from a model's fields", () => {
  it("select, boolean, date and relation fields become chips; text does not", () => {
    const filters = filtersFromFields(FIELDS, { visible: 10 });
    expect(filters.map((f) => [f.key, f.type])).toEqual([
      ["status", "select"],
      ["owner_id", "select"],
      ["active", "boolean"],
      ["created_at", "date"],
    ]);
    expect(filters.find((f) => f.key === "created_at")?.range).toBe(true);
    expect(filters.find((f) => f.key === "owner_id")?.options).toEqual([
      { value: "1", label: "Ana" },
    ]);
  });

  it("a relation with no records to list, or a field the API cannot filter, gets none", () => {
    const keys = filtersFromFields(FIELDS).map((f) => f.key);
    expect(keys).not.toContain("team_id");
    expect(keys).not.toContain("secret");
  });

  it("no date chips when the API cannot compare dates", () => {
    expect(filtersFromFields(FIELDS, { dateRange: false }).map((f) => f.key)).not.toContain(
      "created_at"
    );
  });

  it("only the first ones sit in the bar; the rest wait under Add filter", () => {
    const filters = filtersFromFields(FIELDS, { visible: 2 });
    expect(filters.map((f) => !!f.hidden)).toEqual([false, false, true, true]);
  });

  it("too many choices is a lookup, not a chip", () => {
    const options = Array.from({ length: MAX_FILTER_OPTIONS + 1 }, (_, i) => ({
      value: String(i),
      label: String(i),
    }));
    expect(filtersFromFields([{ key: "x", label: "X", kind: "select", options }])).toEqual([]);
  });

  it("dateRangeOf reads a range or one day", () => {
    expect(dateRangeOf("2026-01-01..2026-01-31")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(dateRangeOf("2026-02-03")).toEqual({ from: "2026-02-03", to: "2026-02-03" });
    expect(dateRangeOf("..2026-02-03")).toEqual({ from: null, to: "2026-02-03" });
    expect(dateRangeOf("soon")).toEqual({ from: null, to: null });
  });
});

const query = (over: Partial<ListQuery> = {}): ListQuery => ({
  filters: {},
  sort: null,
  page: 1,
  pageSize: 25,
  ...over,
});

describe("the query each API understands", () => {
  it("explorer: search across columns and one filter[...] per filter", () => {
    const params = explorerParams(
      query({
        filters: { q: "ana", status: "a", active: true, created_at: "2026-01-01..2026-01-31" },
        sort: { key: "name", direction: "desc" },
        page: 2,
      }),
      FIELDS
    );
    expect(Object.fromEntries(params)).toEqual({
      limit: "25",
      page: "2",
      search: "ana",
      sort: "name",
      dir: "desc",
      "filter[status]": "a",
      "filter[active]": "true",
      "filter[created_at][gte]": "2026-01-01T00:00:00",
      "filter[created_at][lte]": "2026-01-31T23:59:59.999",
    });
  });

  it("explorer: a view's fixed filter is always sent and wins over the user's", () => {
    const params = explorerParams(query({ filters: { status: "a" } }), FIELDS, { status: "draft" });
    expect(params.get("filter[status]")).toBe("draft");
  });

  it("a kon's own route: one filter fits; the rest are returned to apply on the page", () => {
    const { params, unsent } = legacyParams(
      "/api/directory/employees",
      query({
        filters: { q: "x", status: "a", active: true },
        sort: { key: "name", direction: "desc" },
      })
    );
    expect(params.get("search")).toBe("x");
    expect(params.get("sort")).toBe("-name");
    expect([
      params.get("filter_field"),
      params.get("filter_op"),
      params.get("filter_value"),
    ]).toEqual(["status", "equals", "a"]);
    expect(unsent).toEqual([["active", true]]);

    const fixed = legacyParams("/api/x/y", query({ filters: { status: "a" } }), { kind: "k" });
    expect(fixed.params.get("filter_field")).toBe("kind");
    expect(fixed.unsent).toEqual([["status", "a"]]);
  });

  it("dataset search: q, status, filters=field:value, limit and offset", () => {
    const params = datasetSearchParams(
      query({
        filters: { q: "guji", status: "draft", roast: "light", stock: true },
        page: 3,
        pageSize: 10,
      })
    );
    expect(Object.fromEntries(params)).toEqual({
      limit: "10",
      offset: "20",
      q: "guji",
      status: "draft",
      filters: "roast:light,stock:true",
    });
  });

  it("model route: only its sortable and filterable fields are sent", () => {
    const descriptor = { sortable: ["score"], filterable: ["approved"] } as never;
    const params = modelParams(
      query({
        filters: { q: "ignored", approved: false, other: "x" },
        sort: { key: "score", direction: "desc" },
        page: 2,
      }),
      descriptor
    );
    expect(Object.fromEntries(params)).toEqual({
      limit: "25",
      offset: "25",
      sort: "-score",
      approved: "false",
    });
    expect(
      modelParams(query({ sort: { key: "name", direction: "asc" } }), descriptor).has("sort")
    ).toBe(false);
  });
});

describe("fields", () => {
  it("a JSON Schema property becomes a field: kind, read-only, required, relation", () => {
    const id = fieldFromJsonSchema(
      "id",
      { type: "string", format: "uuid", readOnly: true },
      true,
      "id"
    );
    expect(id).toMatchObject({ kind: "id", readonly: true, required: false, hidden: true });
    const rel = fieldFromJsonSchema(
      "owner_id",
      { type: "string", format: "uuid", "x-relation": { table: "auth_users" } },
      true,
      "id"
    );
    expect(rel).toMatchObject({ kind: "relation", relationTable: "auth_users", required: true });
    expect(
      fieldFromJsonSchema("created_at", { type: "string", format: "date-time" }, false, "id")
    ).toMatchObject({ kind: "datetime", readonly: true });
    expect(fieldFromJsonSchema("active", { type: "boolean" }, false, "id").kind).toBe("boolean");
    expect(fieldFromJsonSchema("meta", { type: "object" }, false, "id")).toMatchObject({
      kind: "json",
      hidden: true,
    });
  });

  it("fields guessed from rows: a `<name>Id` column is a relation, nothing is filterable", () => {
    const fields = fieldsFromRows([
      { id: "1", name: "Ana", departmentId: "d1", active: true, createdAt: "2026-01-01T10:00:00Z" },
    ]);
    expect(Object.fromEntries(fields.map((f) => [f.key, f.kind]))).toEqual({
      id: "id",
      name: "text",
      departmentId: "relation",
      active: "boolean",
      createdAt: "datetime",
    });
    expect(fields.every((f) => f.filterable === false)).toBe(true);
    expect(fieldsFromRows([])).toEqual([]);
  });

  it("the form leaves read-only fields out; a relation without records is typed in", () => {
    const form = formFieldsFrom([
      { key: "id", label: "Id", kind: "id", readonly: true },
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "owner_id",
        label: "Owner",
        kind: "relation",
        options: [{ value: "1", label: "Ana" }],
      },
      { key: "team_id", label: "Team", kind: "relation" },
      { key: "notes", label: "Notes", kind: "longtext" },
    ]);
    expect(form.map((f) => [f.key, f.type, f.isRequired])).toEqual([
      ["name", "text", true],
      ["owner_id", "select", false],
      ["team_id", "text", false],
      ["notes", "textarea", false],
    ]);
  });

  it("a dataset's schema: select and yes/no fields filter, plus the entry's status", () => {
    const fields = fieldsFromDataset(
      [
        { id: "a", key: "name", label: "Name", type: "text", order: 0 },
        {
          id: "b",
          key: "roast",
          label: "Roast",
          type: "select",
          order: 1,
          options: [{ label: "Light", value: "light" }],
        },
        { id: "c", key: "inStock", label: "In stock", type: "boolean", order: 2 },
        { id: "d", key: "notes", label: "Notes", type: "richtext", order: 3 },
      ] as never,
      "Status"
    );
    const filters = filtersFromFields(fields, { dateRange: false, visible: 10 });
    expect(filters.map((f) => f.key)).toEqual(["roast", "status", "inStock"]);
    expect(fields.find((f) => f.key === "notes")?.hidden).toBe(true);
  });
});

describe("a list held in memory", () => {
  const rows = [
    { id: "1", name: "Curator", status: "active", calls: 12, created: "2026-01-10T00:00:00Z" },
    { id: "2", name: "Support", status: "paused", calls: 3, created: "2026-02-10T00:00:00Z" },
    { id: "3", name: "Archivist", status: "active", calls: 40, created: "2026-03-10T00:00:00Z" },
  ];
  const fields: ListField[] = [
    { key: "name", label: "Name", kind: "text" },
    { key: "status", label: "Status", kind: "select" },
    { key: "created", label: "Created", kind: "datetime" },
  ];

  it("searches, filters and sorts", () => {
    expect(filterRows(rows, { q: "cur" }, fields).map((r) => r.id)).toEqual(["1"]);
    expect(filterRows(rows, { status: "active" }, fields).map((r) => r.id)).toEqual(["1", "3"]);
    expect(
      filterRows(rows, { created: "2026-02-01..2026-03-31" }, fields).map((r) => r.id)
    ).toEqual(["2", "3"]);
    expect(sortRows(rows, { key: "calls", direction: "desc" }).map((r) => r.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
    expect(sortRows(rows, { key: "name", direction: "asc" }).map((r) => r.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
  });

  it("pages the result and reports the total", async () => {
    const source = memorySource({ id: "x", label: "X", singular: "x", fields, rows: () => rows });
    const page = await source.list({
      filters: {},
      sort: { key: "name", direction: "asc" },
      page: 2,
      pageSize: 2,
    });
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.id)).toEqual(["2"]);
    expect((await source.get("3"))?.name).toBe("Archivist");
  });
});

describe("saved views", () => {
  it("are kept per user and per list, replaced by name, renamed and removed", () => {
    const storage = memoryStorage();
    const ana = browserViewStore("ana", storage);
    ana.save("posts", { name: "Drafts", query: "f.status=draft" });
    ana.save("posts", { name: " Featured ", query: "f.featured=true" });
    expect(ana.list("posts").map((v) => v.name)).toEqual(["Drafts", "Featured"]);
    // Saving under the same name replaces, in place.
    ana.save("posts", { name: "Drafts", query: "f.status=draft&sort=-updated" });
    expect(ana.list("posts")[0]).toEqual({ name: "Drafts", query: "f.status=draft&sort=-updated" });
    // A second reader of the same storage sees them: they survive a reload.
    expect(browserViewStore("ana", storage).list("posts")).toHaveLength(2);
    expect(browserViewStore("luis", storage).list("posts")).toEqual([]);
    expect(ana.list("pages")).toEqual([]);

    expect(ana.rename("posts", "Drafts", "Featured").map((v) => v.name)).toEqual([
      "Drafts",
      "Featured",
    ]);
    expect(ana.rename("posts", "Drafts", "Mine").map((v) => v.name)).toEqual(["Mine", "Featured"]);
    expect(ana.remove("posts", "Mine").map((v) => v.name)).toEqual(["Featured"]);
  });

  it("a broken storage gives no views instead of throwing", () => {
    const store = browserViewStore("ana", {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("full");
      },
    });
    expect(store.list("posts")).toEqual([]);
    expect(store.save("posts", { name: "A", query: "" })).toEqual([{ name: "A", query: "" }]);
  });

  it("the current view is the one whose query matches", () => {
    const views = [{ name: "Drafts", query: "f.status=draft" }];
    expect(currentView(views, "f.status=draft")).toBe("Drafts");
    expect(currentView(views, "f.status=live")).toBeNull();
  });
});

describe("previous / next", () => {
  it("come from the page of the list the record was opened from", () => {
    const storage = memoryStorage();
    rememberNeighbours("posts", ["a", "b", "c"], storage);
    expect(neighboursOf("posts", "b", storage)).toEqual({
      previous: "a",
      next: "c",
      position: 1,
      total: 3,
    });
    expect(neighboursOf("posts", "a", storage).previous).toBeNull();
    expect(neighboursOf("posts", "c", storage).next).toBeNull();
    // Opened from a link, with no list behind it.
    expect(neighboursOf("posts", "z", storage)).toMatchObject({
      previous: null,
      next: null,
      position: -1,
    });
    expect(neighboursOf("pages", "a", storage).total).toBe(0);
  });
});

describe("record titles and CSV", () => {
  it("the title is the model's title field, a usual name, or the first short text", () => {
    expect(recordTitle({ id: "1", coffee: "Guji", name: "x" }, "coffee")).toBe("Guji");
    expect(recordTitle({ id: "1", title: "Hello" })).toBe("Hello");
    expect(recordTitle({ id: "1", data: { name: "From data" } })).toBe("From data");
    expect(recordTitle({ id: "9", owner_id: "abc", sku: "LRK-1" })).toBe("LRK-1");
    expect(recordTitle({ id: "9" })).toBe("9");
    expect(recordTitle(null)).toBe("");
  });

  it("CSV quotes what needs it and defuses formulas", () => {
    expect(
      toCsv(
        ["Name", "Note"],
        [
          ["Ana", 'said "hi", twice'],
          ["=SUM(A1)", { a: 1 }],
          [null, 3],
        ]
      )
    ).toBe('Name,Note\r\nAna,"said ""hi"", twice"\r\n\'=SUM(A1),"{""a"":1}"\r\n,3');
  });
});

const proposal = (over: Partial<ProposalLike> = {}): ProposalLike => ({
  id: "p1",
  status: "executed",
  method: "PATCH",
  path: "/api/datasets/d1/entries/e1",
  createdAt: "2026-11-01T10:00:00.000Z",
  decidedAt: "2026-11-01T10:30:00.000Z",
  executedAt: "2026-11-01T10:30:01.000Z",
  agentName: "Curator",
  decidedByName: "Ana Admin",
  diff: { kind: "update", changes: [{ field: "data.price", before: 19.5, after: 21 }] },
  ...over,
});

describe("history of a record", () => {
  it("diffRecords lists what changed and skips internal keys", () => {
    expect(
      diffRecords({ a: 1, b: "x", _snapshots: [] }, { a: 2, b: "x", c: true }, { a: "Amount" })
    ).toEqual([
      { field: "a", label: "Amount", before: 1, after: 2 },
      { field: "c", label: undefined, before: null, after: true },
    ]);
  });

  it("a proposal targets a record by its API path (either spelling) or its ledger row", () => {
    expect(proposalTargets(proposal(), "/api/datasets/d1/entries/e1", "e1")).toBe(true);
    expect(
      proposalTargets(
        proposal({ path: "/api/data-sets/d1/entries/e1/" }),
        "/api/datasets/d1/entries/e1",
        "e1"
      )
    ).toBe(true);
    expect(proposalTargets(proposal(), "/api/datasets/d1/entries/e2", "e2")).toBe(false);
    expect(
      proposalTargets(
        proposal({ path: "/api/mcp", fieldDiff: { target: { rowId: "e9" } } }),
        "/api/x/e9",
        "e9"
      )
    ).toBe(true);
  });

  it("proposal changes come from the ledger fields, the diff, or the whole record", () => {
    expect(proposalChanges(proposal(), { price: "Price" })).toEqual([
      { field: "price", label: "Price", before: 19.5, after: 21 },
    ]);
    expect(
      proposalChanges(
        proposal({ fieldDiff: { fields: [{ field: "stock", before: 1, after: 0 }] } })
      )
    ).toEqual([{ field: "stock", label: undefined, before: 1, after: 0 }]);
    expect(
      proposalChanges(
        proposal({ diff: { kind: "create", proposed: { title: "T", data: { a: 1 } } } })
      )
    ).toEqual([
      { field: "title", label: undefined, before: null, after: "T" },
      { field: "a", label: undefined, before: null, after: 1 },
    ]);
    expect(proposalChanges(proposal({ diff: null }))).toEqual([]);
  });

  it("maps dates, snapshots and proposals to events, newest first", () => {
    const events = recordHistory({
      id: "e1",
      apiPath: "/api/datasets/d1/entries/e1",
      about: {
        created: "2026-10-01T09:00:00.000Z",
        updated: "2026-11-02T08:00:00.000Z",
        createdBy: "Luis",
      },
      snapshots: [
        {
          timestamp: "2026-10-20T09:00:00.000Z",
          data: { price: 19.5 },
          meta: { triggeredBy: "Luis" },
        },
        { timestamp: "2026-10-10T09:00:00.000Z", data: { price: 18 } },
      ],
      proposals: [proposal(), proposal({ id: "other", path: "/api/datasets/d1/entries/zzz" })],
      labels: { price: "Price" },
    });
    expect(events.map((e) => e.kind)).toEqual([
      "updated",
      "proposal",
      "snapshot",
      "snapshot",
      "created",
    ]);
    const agent = events.find((e) => e.kind === "proposal")!;
    expect(agent).toMatchObject({ agent: "Curator", decidedBy: "Ana Admin", status: "executed" });
    expect(agent.changes).toEqual([{ field: "price", label: "Price", before: 19.5, after: 21 }]);
    // Each snapshot is compared with the one before it; the first has nothing to compare.
    expect(events[2]!.changes).toEqual([
      { field: "price", label: "Price", before: 18, after: 19.5 },
    ]);
    expect(events[3]!.changes).toEqual([]);
  });

  it("an update at the creation time is not a second event", () => {
    const events = recordHistory({
      id: "1",
      apiPath: "/api/x/1",
      about: { created: "2026-10-01T09:00:00.000Z", updated: "2026-10-01T09:00:00.000Z" },
    });
    expect(events.map((e) => e.kind)).toEqual(["created"]);
  });

  it("an agent's change says who asked and who decided, and is tagged", () => {
    const t = (key: string, params?: Record<string, unknown>) =>
      `${key}${params ? ` ${JSON.stringify(params)}` : ""}`;
    const [event] = recordHistory({
      id: "e1",
      apiPath: "/api/datasets/d1/entries/e1",
      about: {},
      proposals: [proposal()],
    });
    const line = historyLine(event!, t, (iso) => iso.slice(0, 10));
    expect(line.title).toBe('record.agentApproved {"agent":"Curator","who":"Ana Admin"}');
    expect(line.tag).toBe("record.tagAgent");
    expect(line.tone).toBe("success");
    expect(line.date).toBe("2026-11-01");
    expect(line.description).toBe('record.fieldsChanged {"n":1}');

    const rejected = historyLine(
      { ...event!, status: "rejected", note: "Too high" },
      t,
      (iso) => iso
    );
    expect(rejected.title).toContain("record.agentRejected");
    expect(rejected.tone).toBe("error");
    expect(rejected.description).toContain("Too high");

    const pending = historyLine({ ...event!, status: "pending" }, t, (iso) => iso);
    expect(pending.title).toContain("record.agentAsks");
    expect(pending.tone).toBe("warning");
  });
});

describe("recorded changes in the history", () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    `${key}${params ? ` ${JSON.stringify(params)}` : ""}`;
  const change = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    action: "update" as const,
    at: "2026-11-05T10:00:00.000Z",
    actor: { type: "user" as const, id: "u1", name: "Ana" },
    changes: [
      { field: "data.price", before: 19.5, after: 21 },
      { field: "data.api_token", redacted: true },
    ],
    truncated: false,
    proposalId: null,
    ...over,
  });

  it("maps fields: an entry's own field by its key, a secret without its value", () => {
    expect(changeFields(change(), { price: "Price" }, "hidden")).toEqual([
      { field: "price", label: "Price", before: 19.5, after: 21 },
      { field: "api_token", label: undefined, before: "hidden", after: "hidden" },
    ]);
    expect(
      changeFields(change({ action: "create", changes: [{ field: "name", after: "x" }] }))
    ).toEqual([{ field: "name", label: undefined, before: null, after: "x" }]);
  });

  it("merges with the dates: a recorded create replaces the row's own, newest first", () => {
    const events = recordHistory({
      id: "e1",
      apiPath: "/api/datasets/d1/entries/e1",
      about: {
        created: "2026-11-01T09:00:00.000Z",
        updated: "2026-11-05T10:00:01.000Z",
      },
      changes: [
        change(),
        change({
          id: "c0",
          action: "create",
          at: "2026-11-01T09:00:00.000Z",
          changes: [{ field: "title", after: "A" }],
        }),
      ],
    });
    // No synthetic "created" (recorded) and no "updated" (it is the newest change).
    expect(events.map((e) => [e.kind, e.action])).toEqual([
      ["change", "update"],
      ["change", "create"],
    ]);
  });

  it("a record changed before the history existed still shows its dates", () => {
    const events = recordHistory({
      id: "e1",
      apiPath: "/x/e1",
      about: { created: "2026-01-01T00:00:00.000Z", updated: "2026-02-01T00:00:00.000Z" },
      changes: [],
    });
    expect(events.map((e) => e.kind)).toEqual(["updated", "created"]);
  });

  it("an agent's change is tagged and named; a person's names the person", () => {
    const [agentEvent] = recordHistory({
      id: "e1",
      apiPath: "/x/e1",
      about: {},
      changes: [change({ actor: { type: "agent", id: "ag1", name: "Curator" } })],
    });
    const line = historyLine(agentEvent!, t, (iso) => iso.slice(0, 10));
    expect(line.title).toBe('record.agentUpdated {"agent":"Curator"}');
    expect(line.tag).toBe("record.tagAgent");

    const [person] = recordHistory({
      id: "e1",
      apiPath: "/x/e1",
      about: {},
      changes: [change({ action: "delete", changes: [] })],
    });
    const deleted = historyLine(person!, t, (iso) => iso);
    expect(deleted.title).toBe('record.changeDeletedBy {"who":"Ana"}');
    expect(deleted.tag).toBe("record.tagDelete");
    expect(deleted.tone).toBe("error");
  });

  it("an approved proposal's write is shown once, as the proposal", () => {
    const events = recordHistory({
      id: "e1",
      apiPath: "/api/datasets/d1/entries/e1",
      about: {},
      proposals: [proposal()],
      changes: [change({ proposalId: proposal().id })],
    });
    expect(events.map((e) => e.kind)).toEqual(["proposal"]);
  });
});
