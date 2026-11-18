/**
 * OpenSandbox runtime adapter (lib/sandbox/opensandbox.ts) against a fake
 * lifecycle + execd server: the requests it makes, the network policy it asks
 * for, the SSE it reads, and that the sandbox is always deleted.
 */

import { describe, expect, test } from "bun:test";

import {
  networkPolicyFor,
  openSandboxConfig,
  parseExecdStream,
  programFor,
  runInOpenSandbox,
  type OpenSandboxConfig,
} from "../lib/sandbox/opensandbox";

const cfg: OpenSandboxConfig = {
  baseUrl: "http://osb.test/v1",
  apiKey: "k",
  image: "registry.test/code-interpreter:1",
  entrypoint: ["tail", "-f", "/dev/null"],
  execdPort: 44772,
  startTimeoutMs: 5_000,
};

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

function fakeServer(opts: { execd?: string; createStatus?: number; states?: string[] } = {}) {
  const calls: { method: string; url: string; body?: unknown; headers: Record<string, string> }[] =
    [];
  const states = [...(opts.states ?? ["Running"])];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.endsWith("/sandboxes")) {
      return json(
        { id: "sb-1", status: { state: states.shift() ?? "Running" } },
        opts.createStatus ?? 202
      );
    }
    if (method === "GET" && url.endsWith("/sandboxes/sb-1"))
      return json({ status: { state: states.shift() ?? "Running" } });
    if (url.endsWith("/endpoints/44772"))
      return json({
        endpoint: "osb.test/sandboxes/sb-1/port/44772",
        headers: { "X-EXECD-ACCESS-TOKEN": "t" },
      });
    if (method === "POST" && (url.endsWith("/code") || url.endsWith("/command"))) {
      return new Response(
        opts.execd ??
          sse({ type: "stdout", text: "hi\n" }, { type: "result", results: { "text/plain": "42" } })
      );
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({ code: "NOT_FOUND", message: url }, 404);
  }) as typeof fetch;
  return { impl, calls };
}

const input = {
  runtime: "opensandbox:python" as const,
  code: "print('hi')\n42",
  payload: { a: 1 },
  timeoutMs: 5_000,
  memoryLimitMb: 128,
  rules: [
    { action: "allow" as const, target: "api.crm.example" },
    { action: "allow" as const, target: "elsewhere.example" },
  ],
  customerDataHosts: ["api.crm.example"],
  actionId: "act-1",
};

describe("configuration", () => {
  test("off unless URL and image are set", () => {
    expect(openSandboxConfig({})).toBeNull();
    expect(openSandboxConfig({ KITSUDEN_OPENSANDBOX_URL: "http://x" })).toBeNull();
    expect(
      openSandboxConfig({
        KITSUDEN_OPENSANDBOX_URL: "http://x/",
        KITSUDEN_OPENSANDBOX_IMAGE: "img",
      })
    ).toMatchObject({
      baseUrl: "http://x",
      image: "img",
      apiKey: null,
      execdPort: 44772,
    });
  });
});

describe("network policy", () => {
  test("deny by default; only hosts that may also receive customer data are allowed", () => {
    expect(
      networkPolicyFor(
        [
          { action: "allow", target: "api.crm.example" },
          { action: "allow", target: "elsewhere.example" },
          { action: "allow", target: "10.0.0.0/8" },
          { action: "allow", ports: [443] },
          { action: "deny", target: "bad.example" },
        ],
        ["*.crm.example", "api.crm.example"]
      )
    ).toEqual({
      defaultAction: "deny",
      egress: [
        { action: "allow", target: "api.crm.example" },
        { action: "deny", target: "bad.example" },
      ],
    });
  });
});

describe("programs and output", () => {
  test("python gets the payload as `event`, shell as $EVENT_JSON", () => {
    const py = programFor("opensandbox:python", "x = 1", { q: 'it\'s "quoted"' });
    expect(py.path).toBe("/code");
    expect(String(py.body.code)).toContain("event = __j.loads");
    expect(String(py.body.code)).not.toContain("quoted");
    const sh = programFor("opensandbox:shell", "echo $EVENT_JSON", { q: 1 });
    expect(sh).toEqual({
      path: "/command",
      body: { command: "echo $EVENT_JSON", envs: { EVENT_JSON: '{"q":1}' } },
    });
  });

  test("SSE: stdout, stderr, result, error; unknown types ignored", () => {
    const out = parseExecdStream(
      sse(
        { type: "init", text: "x" },
        { type: "stdout", text: "a" },
        { type: "stderr", text: "b" },
        { type: "ping" },
        { type: "result", results: { "text/plain": "1" } }
      )
    );
    expect(out).toEqual({ stdout: "a", stderr: "b", result: "1", error: null });
    expect(
      parseExecdStream(sse({ type: "error", error: { ename: "ValueError", evalue: "bad" } })).error
    ).toBe("ValueError: bad");
  });
});

describe("a run", () => {
  test("creates, runs, returns the result and deletes the sandbox", async () => {
    const { impl, calls } = fakeServer({ states: ["Pending", "Running"] });
    const r = await runInOpenSandbox(input, cfg, impl);
    expect(r.error).toBeNull();
    expect(r.success).toBe(true);
    expect(r.result).toBe(42);
    expect(r.logs).toContain("hi");

    const create = calls[0]!;
    expect(create.headers["OPEN-SANDBOX-API-KEY"]).toBe("k");
    expect(create.body).toMatchObject({
      image: { uri: cfg.image },
      env: {},
      networkPolicy: {
        defaultAction: "deny",
        egress: [{ action: "allow", target: "api.crm.example" }],
      },
    });
    const exec = calls.find((c) => c.url.endsWith("/code"))!;
    expect(exec.url).toBe("http://osb.test/sandboxes/sb-1/port/44772/code");
    expect(exec.headers["X-EXECD-ACCESS-TOKEN"]).toBe("t");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "http://osb.test/v1/sandboxes/sb-1",
    });
  });

  test("an error in the code fails the run and still deletes", async () => {
    const { impl, calls } = fakeServer({
      execd: sse({
        type: "error",
        error: { ename: "ZeroDivisionError", evalue: "division by zero" },
      }),
    });
    const r = await runInOpenSandbox(input, cfg, impl);
    expect(r.success).toBe(false);
    expect(r.error).toContain("ZeroDivisionError");
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  test("a sandbox that fails to start is reported and deleted", async () => {
    const { impl, calls } = fakeServer({ states: ["Pending", "Failed"] });
    const r = await runInOpenSandbox(input, cfg, impl);
    expect(r.success).toBe(false);
    expect(r.error).toContain("did not start");
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  test("a refused create leaves nothing to delete", async () => {
    const { impl, calls } = fakeServer({ createStatus: 429 });
    const r = await runInOpenSandbox(input, cfg, impl);
    expect(r.error).toContain("HTTP 429");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
