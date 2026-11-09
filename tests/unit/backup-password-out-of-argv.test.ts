/**
 * `pg_dump`/`pg_restore`/`psql`/`pg_basebackup` without the password on the
 * command line (security review F77): it showed in `ps` while the dump ran.
 *
 * Only `connection` is imported: the script's entry point is behind
 * `import.meta.main`, so nothing runs, no dump is taken and nothing connects.
 */
import { describe, expect, it } from "vitest";

import { connection } from "../../apps/api/scripts/backup";

describe("connection", () => {
  it("removes the password from the URL and passes it in the environment", () => {
    const { url, env } = connection("postgresql://kitsuden:s3cr%40to@db.internal:5433/kitsuden_x");
    expect(url).toBe("postgresql://kitsuden@db.internal:5433/kitsuden_x");
    expect(env.PGPASSWORD).toBe("s3cr@to");
    expect(url).not.toContain("s3cr");
  });

  it("URL parameters stay, never the password (libpq also accepts `?password=`)", () => {
    const a = connection("postgres://u:pass1@h/base?sslmode=require&password=other");
    expect(a.url).toBe("postgres://u@h/base?sslmode=require");
    expect(a.env.PGPASSWORD).toBe("pass1");
    expect(a.url).not.toMatch(/pass1|other/);

    const b = connection("postgresql://u@h/base?password=only%20here&sslmode=require");
    expect(b.url).toBe("postgresql://u@h/base?sslmode=require");
    expect(b.env.PGPASSWORD).toBe("only here");
  });

  it("without a password the environment is not given one", () => {
    const { url, env } = connection("postgresql://ana@[::1]/db");
    expect(url).toBe("postgresql://ana@[::1]/db");
    expect(env.PGPASSWORD).toBe(process.env.PGPASSWORD);
  });

  it("refuses what is not a Postgres URL instead of passing it on as is", () => {
    expect(() => connection("lite")).toThrow();
    expect(() => connection("host=h user=u password=p dbname=d")).toThrow();
    expect(() => connection("mysql://u:p@h/b")).toThrow();
  });
});
