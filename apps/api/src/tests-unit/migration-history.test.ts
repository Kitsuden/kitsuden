/**
 * `migrations/history.json`: renamed and reworded migrations keep their place in the history
 * ============================================================================
 *
 * A database that applied `0002_pedidos_seguros.sql` must take `0002_secure_orders.sql` as applied
 * (not run it again), and a checksum recorded before a comment was translated must not stop the
 * runner — but only when the folder declares it. Nothing is guessed.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  adoptRenamed,
  hadChecksum,
  previousName,
  type AppliedRow,
  type NamedMigration,
} from "../lib/migration-history";

const dialect = new PgDialect();

function folder(history?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-history-"));
  if (history !== undefined) writeFileSync(join(dir, "history.json"), JSON.stringify(history));
  return dir;
}

const file = (dir: string, name: string, checksum = "new0000000000000"): NamedMigration => ({
  name: `kon-shop/${name}`,
  path: join(dir, name),
  checksum,
});

describe("migration history.json", () => {
  it("adopts a declared rename and brings a declared previous checksum up to date", async () => {
    const dir = folder({
      renamed: { "0002_secure_orders.sql": "0002_pedidos_seguros.sql" },
      previousChecksums: { "0002_secure_orders.sql": ["old0000000000000"] },
    });
    const f = file(dir, "0002_secure_orders.sql");
    expect(previousName(f)).toBe("kon-shop/0002_pedidos_seguros.sql");

    const applied = new Map<string, AppliedRow & { baselined: boolean }>([
      [
        "kon-shop/0002_pedidos_seguros.sql",
        {
          name: "kon-shop/0002_pedidos_seguros.sql",
          checksum: "old0000000000000",
          baselined: false,
        },
      ],
    ]);
    const queries: string[] = [];
    const adopted = await adoptRenamed([f], applied, async (q) => {
      const { sql, params } = dialect.sqlToQuery(q);
      queries.push(`${sql} ${JSON.stringify(params)}`);
    });

    expect(adopted).toEqual([
      "kon-shop/0002_pedidos_seguros.sql → kon-shop/0002_secure_orders.sql",
    ]);
    expect(applied.has("kon-shop/0002_pedidos_seguros.sql")).toBe(false);
    expect(applied.get("kon-shop/0002_secure_orders.sql")).toEqual({
      name: "kon-shop/0002_secure_orders.sql",
      checksum: "new0000000000000",
      baselined: false,
    });
    expect(queries[0]).toContain(
      "UPDATE kitsuden_migrations SET name = $1, checksum = $2 WHERE name = $3"
    );
    expect(queries[0]).toContain(
      '["kon-shop/0002_secure_orders.sql","new0000000000000","kon-shop/0002_pedidos_seguros.sql"]'
    );
  });

  it("keeps an undeclared recorded checksum, so the drift check still reports it", async () => {
    const dir = folder({ renamed: { "0002_secure_orders.sql": "0002_pedidos_seguros.sql" } });
    const f = file(dir, "0002_secure_orders.sql");
    const applied = new Map<string, AppliedRow>([
      [
        "kon-shop/0002_pedidos_seguros.sql",
        { name: "kon-shop/0002_pedidos_seguros.sql", checksum: "someone-edited00" },
      ],
    ]);
    await adoptRenamed([f], applied, async () => undefined);
    expect(applied.get("kon-shop/0002_secure_orders.sql")?.checksum).toBe("someone-edited00");
    expect(hadChecksum(f, "someone-edited00")).toBe(false);
  });

  it("guesses nothing: without history.json a renamed file is a new migration", async () => {
    const dir = folder();
    const f = file(dir, "0002_secure_orders.sql");
    const applied = new Map<string, AppliedRow>([
      [
        "kon-shop/0002_pedidos_seguros.sql",
        { name: "kon-shop/0002_pedidos_seguros.sql", checksum: "x" },
      ],
    ]);
    expect(await adoptRenamed([f], applied, async () => undefined)).toEqual([]);
    expect(applied.has("kon-shop/0002_secure_orders.sql")).toBe(false);
  });

  it("an already-applied new name is left alone", async () => {
    const dir = folder({ renamed: { "0002_secure_orders.sql": "0002_pedidos_seguros.sql" } });
    const f = file(dir, "0002_secure_orders.sql");
    const applied = new Map<string, AppliedRow>([
      [
        "kon-shop/0002_secure_orders.sql",
        { name: "kon-shop/0002_secure_orders.sql", checksum: "new0000000000000" },
      ],
      [
        "kon-shop/0002_pedidos_seguros.sql",
        { name: "kon-shop/0002_pedidos_seguros.sql", checksum: "x" },
      ],
    ]);
    expect(await adoptRenamed([f], applied, async () => undefined)).toEqual([]);
  });

  it("adopts a file another kon applied, when a kon absorbed it", async () => {
    const dir = folder({
      renamed: { "0006_deckshow_initial.sql": "kon-deckshow/0000_initial.sql" },
    });
    const f: NamedMigration = {
      name: "kon-cardsim/0006_deckshow_initial.sql",
      path: join(dir, "0006_deckshow_initial.sql"),
      checksum: "c",
    };
    expect(previousName(f)).toBe("kon-deckshow/0000_initial.sql");
    const applied = new Map<string, AppliedRow>([
      ["kon-deckshow/0000_initial.sql", { name: "kon-deckshow/0000_initial.sql", checksum: "c" }],
    ]);
    expect(await adoptRenamed([f], applied, async () => undefined)).toEqual([
      "kon-deckshow/0000_initial.sql → kon-cardsim/0006_deckshow_initial.sql",
    ]);
  });

  it("refuses a malformed history.json instead of ignoring it", () => {
    const dir = folder({ renamed: { "secure.sql": "0002_pedidos_seguros.sql" } });
    expect(() => previousName(file(dir, "0002_secure_orders.sql"))).toThrow(/4-digit prefix/);
  });

  it("core apps/api/src/db/migrations/history.json adopts every renamed migration and recognizes its previous checksums", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const migDir = resolve(import.meta.dir, "../db/migrations");
    const h = JSON.parse(readFileSync(join(migDir, "history.json"), "utf8")) as {
      renamed: Record<string, string>;
      previousChecksums: Record<string, string[]>;
    };
    expect(Object.keys(h.renamed).length).toBeGreaterThanOrEqual(22);

    for (const [newName, oldName] of Object.entries(h.renamed)) {
      const prevs = h.previousChecksums[newName] ?? [];
      expect(prevs.length).toBeGreaterThan(0);
      const f: NamedMigration = {
        name: `migrations/${newName}`,
        path: join(migDir, newName),
        checksum: "current000000000",
      };
      expect(previousName(f)).toBe(`migrations/${oldName}`);
      for (const oldSum of prevs) {
        expect(hadChecksum(f, oldSum)).toBe(true);
      }
      const applied = new Map<string, AppliedRow>([
        [`migrations/${oldName}`, { name: `migrations/${oldName}`, checksum: prevs[0] }],
      ]);
      const adopted = await adoptRenamed([f], applied, async () => undefined);
      expect(adopted).toEqual([`migrations/${oldName} → migrations/${newName}`]);
      expect(applied.get(`migrations/${newName}`)?.checksum).toBe("current000000000");
    }
  });
});
