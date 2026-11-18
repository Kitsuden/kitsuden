/**
 * The egress policy and the vault, through the real sandbox: the decisions are
 * checked OUTSIDE (a local server that must or must not receive the request),
 * not only with what the code returns.
 */

import { createServer, type Server } from "node:http";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { _resetEgressPolicyCache } from "../lib/egress-policy";
import { executeSandbox, type MockFetchRequest, type SandboxInput } from "../lib/worker-sandbox";

setDefaultTimeout(60_000);

const base: SandboxInput = {
  code: "",
  payload: {},
  envVars: {},
  timeoutMs: 5000,
  memoryLimitMb: 32,
};
const run = (code: string, extra: Partial<SandboxInput> = {}) =>
  executeSandbox({ ...base, ...extra, code });

let server: Server;
let port = 0;
const received: { url: string; authorization?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({ url: req.url ?? "", authorization: req.headers.authorization });
    res.setHeader("content-type", "text/plain");
    res.end(`echo:${req.headers.authorization ?? "none"}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH = "true";
});

afterAll(() => {
  delete process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH;
  server.close();
});

afterEach(() => {
  delete process.env.KITSUDEN_EGRESS_DENY_ALWAYS;
  delete process.env.KITSUDEN_EGRESS_PORTS;
  _resetEgressPolicyCache();
});

describe("egress policy in the sandbox", () => {
  test("fetchAllow still works (backward compatible)", async () => {
    const r = await run(`return (await fetch("http://127.0.0.1:${port}/a")).status;`, {
      fetchAllow: ["127.0.0.1"],
    });
    expect(r.error).toBeNull();
    expect(r.result).toBe(200);
  });

  test("a platform CIDR deny beats the action's allow, and nothing is sent", async () => {
    process.env.KITSUDEN_EGRESS_DENY_ALWAYS = "127.0.0.0/8";
    const before = received.length;
    const r = await run(`return (await fetch("http://127.0.0.1:${port}/b")).status;`, {
      fetchAllow: ["127.0.0.1"],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("platform egress policy");
    expect(received.length).toBe(before);
  });

  test("an action deny rule beats its own allow", async () => {
    const before = received.length;
    const r = await run(`return (await fetch("http://127.0.0.1:${port}/c")).status;`, {
      egress: [
        { action: "allow", target: "127.0.0.1" },
        { action: "deny", ports: [port] },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("this action's egress rules");
    expect(received.length).toBe(before);
  });

  test("the operator's port floor refuses other ports", async () => {
    process.env.KITSUDEN_EGRESS_PORTS = "443";
    const r = await run(`return (await fetch("http://127.0.0.1:${port}/d")).status;`, {
      fetchAllow: ["127.0.0.1"],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("port floor");
  });

  test("a CIDR allow lets a name through after resolution (localhost → 127.0.0.1)", async () => {
    const r = await run(`return (await fetch("http://localhost:${port}/e")).status;`, {
      egress: [
        { action: "allow", target: "127.0.0.0/8" },
        { action: "allow", target: "::1" },
      ],
    });
    expect(r.error).toBeNull();
    expect(r.result).toBe(200);
  });
});

describe("vault in the sandbox", () => {
  test("never over http: the request is refused before it leaves", async () => {
    const before = received.length;
    const r = await run(`return (await fetch("http://127.0.0.1:${port}/f")).status;`, {
      fetchAllow: ["127.0.0.1"],
      credentials: [
        {
          secret: "K",
          host: "127.0.0.1",
          header: "Authorization",
          format: "Bearer {secret}",
          value: "v4lue-secret",
        },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("only sent over https");
    expect(received.length).toBe(before);
  });

  test("the code cannot read the value: it is not in env, and a test sees a placeholder", async () => {
    const seen: MockFetchRequest[] = [];
    const r = await run(
      `const res = await fetch("https://api.stripe.com/v1/x", { headers: { Authorization: "mine" } });
       return { env: Object.keys(env), body: await res.text() };`,
      {
        egress: [{ action: "allow", target: "api.stripe.com" }],
        credentials: [
          {
            secret: "STRIPE_KEY",
            host: "api.stripe.com",
            header: "Authorization",
            format: "Bearer {secret}",
            value: "sk_live_real",
          },
        ],
        probe: {
          fetch: async (p) => {
            seen.push(p);
            return { status: 200, headers: {}, body: "ok" };
          },
        },
      }
    );
    expect(r.error).toBeNull();
    expect(r.result).toEqual({ env: [], body: "ok" });
    expect(seen[0]!.headers).toEqual({ Authorization: "Bearer [vault:STRIPE_KEY]" });
    expect(JSON.stringify(seen)).not.toContain("sk_live_real");
  });

  test("the test path applies the same egress policy", async () => {
    const r = await run(`return (await fetch("https://other.example/")).status;`, {
      egress: [{ action: "allow", target: "api.stripe.com" }],
      probe: { fetch: async () => ({ status: 200, headers: {}, body: "" }) },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Host not allowed");
  });
});
