import { describe, expect, it } from "vitest";

import {
  ariaSort,
  columnLabel,
  defaultHiddenColumns,
  isIdColumn,
  orderColumns,
  relationDisplay,
  rowTitle,
  shortId,
  titleColumn,
} from "./table-columns";

const cols = (...names: string[]) => names.map((name) => ({ name, type: "text" }));

describe("identifier columns", () => {
  it("are hidden by default, and stay available", () => {
    const columns = cols("id", "uuid", "title", "author_id");
    expect([...defaultHiddenColumns(columns)]).toEqual(["id", "uuid"]);
    expect(isIdColumn("author_id")).toBe(false);
  });

  it("a table of identifiers only keeps them", () => {
    expect(defaultHiddenColumns(cols("id")).size).toBe(0);
  });
});

describe("column order", () => {
  it("puts the title column first and identifiers last", () => {
    const ordered = orderColumns(cols("id", "created_at", "status", "title", "slug"));
    expect(ordered.map((c) => c.name)).toEqual(["title", "created_at", "status", "slug", "id"]);
  });

  it("prefers title over name over email", () => {
    expect(titleColumn(cols("email", "name", "title"))).toBe("title");
    expect(titleColumn(cols("email", "name"))).toBe("name");
    expect(titleColumn(cols("id", "email"))).toBe("email");
  });

  it("falls back to the first text column that is not an id or a relation", () => {
    const columns = [
      { name: "id", type: "text" },
      { name: "owner_id", type: "text" },
      { name: "amount", type: "number" },
      { name: "notes", type: "text" },
    ];
    expect(titleColumn(columns)).toBe("notes");
    expect(orderColumns(columns).map((c) => c.name)).toEqual(["notes", "owner_id", "amount", "id"]);
  });

  it("keeps the schema order when nothing titles the row", () => {
    const columns = [
      { name: "amount", type: "number" },
      { name: "paid", type: "boolean" },
    ];
    expect(orderColumns(columns)).toEqual(columns);
  });
});

describe("relation cells", () => {
  const id = "5605b478-5605-4605-ab47-000000000001";

  it("show the looked-up label", () => {
    expect(relationDisplay({ author_id: id }, "author_id", { [id]: "Ana Larkspur" })).toBe(
      "Ana Larkspur"
    );
  });

  it("show the embedded record's display field", () => {
    expect(relationDisplay({ author_id: id, author: { id, name: "Ana" } }, "author_id")).toBe(
      "Ana"
    );
    expect(relationDisplay({ ownerId: { id, title: "Roastery" } }, "ownerId")).toBe("Roastery");
  });

  it("show a sibling name column", () => {
    expect(relationDisplay({ managerId: id, managerName: "Berta" }, "managerId")).toBe("Berta");
    expect(relationDisplay({ owner_id: id, owner_name: "Berta" }, "owner_id")).toBe("Berta");
  });

  it("fall back to a short id, and to a dash when empty", () => {
    expect(relationDisplay({ author_id: id }, "author_id")).toBe("5605b478…");
    expect(relationDisplay({ author_id: null }, "author_id")).toBe("-");
    expect(relationDisplay({ author_id: 7 }, "author_id")).toBe("7");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("headers", () => {
  it("label a column for people", () => {
    expect(columnLabel("author_id")).toBe("Author");
    expect(columnLabel("createdAt")).toBe("Created At");
    expect(columnLabel("display_name")).toBe("Display name");
  });

  it("aria-sort follows the direction", () => {
    expect(ariaSort("asc")).toBe("ascending");
    expect(ariaSort("desc")).toBe("descending");
    expect(ariaSort(null)).toBe("none");
  });

  it("a row is named by its title, or by a short id", () => {
    const columns = cols("id", "title");
    expect(rowTitle({ id: "5605b478-5605", title: "Espresso" }, columns)).toBe("Espresso");
    expect(rowTitle({ id: "5605b478-5605-4605", title: "" }, columns)).toBe("5605b478…");
  });
});
