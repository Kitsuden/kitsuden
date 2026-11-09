/**
 * Limit on what leaves: customer data read by an execution does not go out
 * ============================================================================
 *
 * The pure part (lib/customer-data.ts): what is tracked from what an execution
 * reads, what counts as "contains it" on the way out, and redaction. Then the
 * sandbox: code that reads a marked field through a (fake) `kitsuden.api` and
 * sends it with `fetch` to a local server; the server must receive NOTHING
 * unless the host is allowed for customer data. No database, no network.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  buildCatalog,
  customerDataHosts,
  egressProblem,
  emailProblem,
  hostAllowedForCustomerData,
  isLoopbackHost,
  MarkedValues,
  REDACTED,
  redactPromptMessages,
  type EgressBlock,
} from "../lib/customer-data";
import { executeSandbox, type SandboxInput, type SandboxResponse } from "../lib/worker-sandbox";

setDefaultTimeout(60_000);

const DS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const catalog = buildCatalog(
  [{ id: DS_ID, slug: "clients", fields: { email: "customer", phone: "personal" } }],
  [{ id: "kon-crm", tables: { crm_contacts: { full_name: "customer" } } }]
);

const entry = (data: Record<string, unknown>, datasetId = DS_ID) => ({
  id: "e1",
  dataSetId: datasetId,
  title: "row",
  data,
});

describe("tracking what an execution read", () => {
  test("marked dataset fields are tracked; unmarked ones and other datasets are not", () => {
    const m = new MarkedValues(catalog);
    m.collect({
      docs: [
        entry({ email: "ana.gil@example.com", plan: "enterprise-gold" }),
        // Same key in a dataset WITHOUT marks: not customer data.
        entry({ email: "newsletter@example.org" }, OTHER_ID),
      ],
    });
    expect(m.find("x ana.gil@example.com y")).toBe("dataset:clients.email (customer)");
    expect(m.find("enterprise-gold")).toBeNull();
    expect(m.find("newsletter@example.org")).toBeNull();
  });

  test("the API path names the dataset when the rows do not", () => {
    const m = new MarkedValues(catalog);
    m.collectText(
      JSON.stringify({ data: { phone: "+34 600 111 222" } }),
      `/api/datasets/${DS_ID}/entries`
    );
    expect(m.find("call +34 600 111 222")).toContain("phone");
  });

  test("kon columns are tracked by name, in snake and camel case", () => {
    const m = new MarkedValues(catalog);
    m.collect([{ fullName: "Beatriz Ortega" }, { full_name: "Carlos Ruiz" }]);
    expect(m.find("Hello BEATRIZ   ortega")).toContain("crm_contacts.full_name");
    expect(m.find("carlos ruiz")).not.toBeNull();
  });

  test("short values are not tracked (too many false matches)", () => {
    const m = new MarkedValues(catalog);
    m.collect(entry({ email: "a@b" }));
    expect(m.size).toBe(0);
  });

  test("URL-encoded and JSON-escaped copies are still found", () => {
    const m = new MarkedValues(catalog);
    m.collect(entry({ email: "ana.gil@example.com" }));
    expect(m.find("https://x.test/?q=ana.gil%40example.com")).not.toBeNull();
    expect(m.find('{"v":"ana.gil\\u0040example.com"}')).not.toBeNull();
    // Reversed is NOT found: documented limit.
    expect(m.find("moc.elpmaxe@lig.ana")).toBeNull();
  });

  test("redaction replaces marked keys and strings that contain a tracked value", () => {
    const m = new MarkedValues(catalog);
    const { value, redacted } = m.redact({
      datasetId: DS_ID,
      entries: [entry({ email: "ana.gil@example.com", plan: "gold-plan" })],
      note: "follow up with ana.gil@example.com",
    });
    const v = value as { entries: Array<{ data: Record<string, unknown> }>; note: string };
    expect(v.entries[0]!.data.email).toBe(REDACTED);
    expect(v.entries[0]!.data.plan).toBe("gold-plan");
    expect(v.note).toBe(REDACTED);
    expect(redacted).toContain("dataset:clients.email (customer)");
  });

  test("hosts allowed for customer data: server list + action list, with wildcards", () => {
    process.env.KITSUDEN_CUSTOMER_DATA_HOSTS = "crm.example.com";
    try {
      const list = customerDataHosts(["*.mail.example.com"]);
      expect(hostAllowedForCustomerData("crm.example.com", list)).toBe(true);
      expect(hostAllowedForCustomerData("eu.mail.example.com", list)).toBe(true);
      expect(hostAllowedForCustomerData("mail.example.com", list)).toBe(false);
      expect(hostAllowedForCustomerData("evil.test", list)).toBe(false);
    } finally {
      delete process.env.KITSUDEN_CUSTOMER_DATA_HOSTS;
    }
  });

  test("a guard that could not load the marks refuses every other host", () => {
    const p = egressProblem(
      { marked: new MarkedValues(), allowedHosts: ["ok.test"], strict: true },
      { url: "https://other.test/", hostname: "other.test", body: "nothing" }
    );
    expect(p?.message).toMatch(/unavailable/);
    expect(
      egressProblem(
        { marked: new MarkedValues(), allowedHosts: ["ok.test"], strict: true },
        { url: "https://ok.test/", hostname: "ok.test" }
      )
    ).toBeNull();
  });
});

// ── Transformed copies ──────────────────────────────────────────────────────

const EMAIL = "Ana.Gil@Example.com";
const reading = () => {
  const m = new MarkedValues(catalog);
  m.collect(entry({ email: EMAIL, phone: "+34 600 111 222", plan: "gold-plan" }));
  return m;
};
const b64 = (s: string) => Buffer.from(s).toString("base64");
const hash = (algorithm: string, s: string, encoding: "hex" | "base64") =>
  createHash(algorithm).update(s).digest(encoding);

describe("transformed copies are found", () => {
  test("base64 and base64url runs, alone or inside a larger encoded body", () => {
    const m = reading();
    expect(m.find(b64(EMAIL))).toContain("email");
    expect(
      m.find(`token=${Buffer.from("ana.gil@example.com").toString("base64url")}&x=1`)
    ).toContain("email");
    expect(m.find(`{"blob":"${b64(JSON.stringify({ who: EMAIL, n: 1 }))}"}`)).toContain("email");
    // As a path segment, and base64 of a percent-encoded copy.
    expect(m.find(`https://x.test/c/${b64(EMAIL)}`)).toContain("email");
    expect(m.find(b64("who=ana.gil%40example.com"))).toContain("email");
  });

  test("hex runs (even length)", () => {
    const m = reading();
    expect(m.find(Buffer.from(EMAIL).toString("hex"))).toContain("email");
    expect(m.find(`id=${Buffer.from(EMAIL).toString("hex").toUpperCase()}`)).toContain("email");
  });

  test("SHA-256, SHA-1 and MD5 digests, of the value as read and normalized, hex and base64", () => {
    const m = reading();
    for (const algorithm of ["sha256", "sha1", "md5"]) {
      for (const form of [EMAIL, "ana.gil@example.com"]) {
        expect(m.find(`h=${hash(algorithm, form, "hex")}`)).toContain("email");
        expect(m.find(JSON.stringify({ h: hash(algorithm, form, "base64") }))).toContain("email");
      }
    }
    expect(m.find(hash("sha256", "someone.else@example.com", "hex"))).toBeNull();
  });

  test("a phone number reformatted to digits only, on whole digit groups", () => {
    const m = reading();
    expect(m.find("34600111222")).toContain("phone");
    expect(m.find("tel: 34-600-111-222")).toContain("phone");
    expect(m.find("(34) 600.111.222")).toContain("phone");
    // Not inside a longer number, nor a part of it.
    expect(m.find("order 1346001112229")).toBeNull();
    expect(m.find("346001112220")).toBeNull();
    expect(m.find("600111222")).toBeNull();
  });

  test("a value that is only digits is not found inside a longer number", () => {
    const m = new MarkedValues(catalog);
    m.collect(entry({ phone: "600111222" }));
    expect(m.find("call 600 111 222 today")).toContain("phone");
    expect(m.find("ts=16001112223")).toBeNull();
  });

  test("random base64 and binary hex are not mistaken for anything", () => {
    const m = reading();
    expect(m.find("aGVsbG8gd29ybGQgdGhpcyBpcyBmaW5l")).toBeNull();
    expect(m.find(createHash("sha256").update("x").digest("hex"))).toBeNull();
  });

  test("the work on a large body is bounded", () => {
    const m = reading();
    // 4 MB of distinct base64 runs that decode to text, with the value past the cap.
    const junk = Array.from({ length: 40_000 }, (_, i) =>
      b64(`harmless text number ${i} `.repeat(3))
    ).join(" ");
    const body = `${junk} ${b64(EMAIL)}`;
    const t0 = performance.now();
    m.find(body);
    expect(performance.now() - t0).toBeLessThan(5_000);
    // Plain copies are still found anywhere in the body.
    expect(m.find(`${junk} ana.gil@example.com`)).toContain("email");
  });
});

describe("redacting free text (model prompts)", () => {
  test("cuts every form out and keeps the rest", () => {
    const m = reading();
    const { text, redacted } = m.redactText(
      `Write to ANA.GIL@example.com (phone 34 600 111 222), id ${b64(EMAIL)}, hash ${hash("md5", EMAIL, "hex")}, plan gold-plan.`
    );
    expect(text).not.toMatch(/ana\.gil/i);
    expect(text).not.toContain("600");
    expect(text).not.toContain(b64(EMAIL));
    expect(text).toContain("plan gold-plan");
    expect(text.match(/\[redacted: customer data\]/g)).toHaveLength(4);
    expect(redacted.sort()).toEqual([
      "dataset:clients.email (customer)",
      "dataset:clients.phone (personal)",
    ]);
  });

  test("a JSON tool result is redacted field by field, marked keys included", () => {
    const m = reading();
    const { text } = m.redactText(
      JSON.stringify([
        {
          id: "e1",
          dataSetId: DS_ID,
          data: { email: "a@b", plan: "gold-plan", note: "cc ana.gil@example.com" },
        },
      ])
    );
    const rows = JSON.parse(text) as Array<{ data: Record<string, string> }>;
    expect(rows[0]!.data.email).toBe(REDACTED);
    expect(rows[0]!.data.plan).toBe("gold-plan");
    expect(rows[0]!.data.note).toBe(`cc ${REDACTED}`);
  });

  test("messages and tool-call arguments", () => {
    const m = reading();
    const { messages, redacted } = redactPromptMessages(m, [
      { role: "system", content: "You help." },
      { role: "user", content: "Email ana.gil@example.com" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ function: { name: "t", arguments: '{"to":"ana.gil@example.com"}' } }],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("ana.gil");
    expect(messages[0]!.content).toBe("You help.");
    expect(redacted).toEqual(["dataset:clients.email (customer)"]);
  });

  test("text without tracked values is returned as it was", () => {
    const m = reading();
    expect(m.redactText("nothing to see, 100% sure").text).toBe("nothing to see, 100% sure");
    expect(redactPromptMessages(new MarkedValues(catalog), [{ content: "x" }]).redacted).toEqual(
      []
    );
  });
});

describe("email and local hosts", () => {
  const guard = () => ({ marked: reading(), allowedHosts: ["crm.example.com"] });

  test("a third-party recipient is refused when the mail carries a tracked value", () => {
    const p = emailProblem(guard(), {
      to: "someone@other.test",
      subject: "Lead",
      html: "<p>ana.gil@example.com</p>",
    });
    expect(p?.message).toMatch(
      /cannot be emailed to other\.test: the html contains a value of dataset:clients\.email/
    );
    expect(p?.block).toMatchObject({ host: "other.test", where: "html" });
    expect(
      emailProblem(guard(), { to: "someone@other.test", subject: "Hi", html: "<p>gold-plan</p>" })
    ).toBeNull();
  });

  test("the customer's own address, and an allowed domain, may receive it", () => {
    expect(
      emailProblem(guard(), {
        to: "ANA.GIL@example.com",
        subject: "Your plan",
        html: "Hi ana.gil@example.com",
      })
    ).toBeNull();
    expect(
      emailProblem(guard(), {
        to: "sales@crm.example.com",
        subject: "x",
        html: "ana.gil@example.com",
      })
    ).toBeNull();
  });

  test("without the marks every email to a domain not allowed is refused", () => {
    const p = emailProblem(
      { marked: new MarkedValues(), allowedHosts: [], strict: true },
      { to: "x@other.test", subject: "s", html: "h" }
    );
    expect(p?.block.where).toBe("unchecked");
  });

  test("loopback hosts", () => {
    for (const h of ["localhost", "api.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["api.openai.com", "10.0.0.1", "localhost.evil.test", "128.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

// ── The sandbox ─────────────────────────────────────────────────────────────

let server: Server;
let port = 0;
const received: string[] = [];

beforeAll(async () => {
  process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH = "true";
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(`${req.method} ${req.url} ${body}`);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  delete process.env.KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH;
  server?.close();
});

/** A fake `kitsuden.api` that serves one entry of the marked dataset. */
const api: SandboxInput["api"] = async (_method, path): Promise<SandboxResponse> => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ docs: [entry({ email: "ana.gil@example.com", plan: "gold-plan" })] }),
  url: path,
});

async function run(code: string, allowedHosts: string[] = []) {
  const blocks: EgressBlock[] = [];
  const r = await executeSandbox({
    code,
    payload: {},
    envVars: {},
    timeoutMs: 5000,
    memoryLimitMb: 32,
    fetchAllow: ["127.0.0.1"],
    api,
    customerData: {
      marked: new MarkedValues(catalog),
      allowedHosts,
      onBlock: (b) => blocks.push(b),
    },
  });
  return { r, blocks };
}

const READ = `const rows = (await (await kitsuden.api.get('/api/datasets/${DS_ID}/entries')).json()).docs;`;

describe("sandbox fetch with customer data", () => {
  test("sending a marked value to a host not allowed is refused, and nothing arrives", async () => {
    received.length = 0;
    const { r, blocks } = await run(`${READ}
      try {
        await fetch('http://127.0.0.1:${port}/collect', { method: 'POST', body: JSON.stringify({ who: rows[0].data.email }) });
        return 'sent';
      } catch (e) { return String(e.message || e); }`);
    expect(r.error).toBeNull();
    expect(String(r.result)).toMatch(
      /Customer data cannot be sent to 127\.0\.0\.1.*dataset:clients\.email/
    );
    expect(received).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      channel: "sandbox_fetch",
      decision: "refused",
      host: "127.0.0.1",
      where: "body",
    });
    expect(JSON.stringify(blocks)).not.toContain("ana.gil");
  });

  test("in the query string or a header, too", async () => {
    received.length = 0;
    const { r } = await run(`${READ}
      const out = [];
      for (const req of [
        ['http://127.0.0.1:${port}/q?e=' + encodeURIComponent(rows[0].data.email), {}],
        ['http://127.0.0.1:${port}/h', { headers: { 'X-Who': rows[0].data.email } }],
      ]) {
        try { await fetch(req[0], req[1]); out.push('sent'); } catch (e) { out.push(String(e.message || e)); }
      }
      return out;`);
    expect((r.result as string[]).every((x) => /Customer data/.test(x))).toBe(true);
    expect(received).toEqual([]);
  });

  test("unmarked values and requests without customer data still go out", async () => {
    received.length = 0;
    const { r } = await run(`${READ}
      const res = await fetch('http://127.0.0.1:${port}/ok', { method: 'POST', body: rows[0].data.plan });
      return res.status;`);
    expect(r.error).toBeNull();
    expect(r.result).toBe(200);
    expect(received).toEqual(["POST /ok gold-plan"]);
  });

  test("a host allowed for customer data receives it", async () => {
    received.length = 0;
    const { r, blocks } = await run(
      `${READ}
      const res = await fetch('http://127.0.0.1:${port}/crm', { method: 'POST', body: rows[0].data.email });
      return res.status;`,
      ["127.0.0.1"]
    );
    expect(r.result).toBe(200);
    expect(received).toEqual(["POST /crm ana.gil@example.com"]);
    expect(blocks).toEqual([]);
  });

  test("the trigger event counts as read", async () => {
    received.length = 0;
    const marked = new MarkedValues(catalog);
    marked.collect({ datasetId: DS_ID, entries: [entry({ email: "event.person@example.com" })] });
    const r = await executeSandbox({
      code: `try { await fetch('http://127.0.0.1:${port}/e', { method: 'POST', body: 'x ' + event.who }); return 'sent'; } catch (e) { return String(e.message || e); }`,
      payload: { who: "event.person@example.com" },
      envVars: {},
      timeoutMs: 5000,
      memoryLimitMb: 32,
      fetchAllow: ["127.0.0.1"],
      customerData: { marked, allowedHosts: [] },
    });
    expect(String(r.result)).toMatch(/Customer data cannot be sent/);
    expect(received).toEqual([]);
  });
});
