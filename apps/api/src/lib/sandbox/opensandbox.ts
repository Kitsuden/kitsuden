/**
 * Optional runtime: OpenSandbox (Python or shell in a container / microVM)
 * ============================================================================
 *
 * QuickJS (worker-sandbox.ts) runs JavaScript only. For a code action that
 * needs Python or a shell, an operator can point Kitsuden at an OpenSandbox
 * server (https://github.com/opensandbox-group/OpenSandbox, Apache-2.0) and set
 * `config.runtime` to `opensandbox:python` or `opensandbox:shell`.
 *
 * What it does per execution:
 *   1. `POST /sandboxes` on the lifecycle API with the operator's image, the
 *      action's limits, NO environment, and a network policy that denies
 *      everything except the hosts below;
 *   2. waits for `Running`, asks for the execd endpoint (`/endpoints/44772`);
 *   3. runs the code (`POST /code` for Python, `POST /command` for shell) and
 *      reads its server-sent events (stdout, stderr, result, error);
 *   4. deletes the sandbox, always.
 *
 * What it does NOT have, by design:
 *   · `kitsuden.api`: the code cannot call the Kitsuden API (no scopes);
 *   · vault credentials: an action with `credentials` is refused on this
 *     runtime (OpenSandbox has its own vault; wiring it is future work);
 *   · the customer-data check on each request (it runs in our process, not in
 *     the sandbox). To keep the same guarantee, the sandbox may only reach
 *     hosts that the action allows AND that may receive customer data
 *     (`customerDataHosts` / KITSUDEN_CUSTOMER_DATA_HOSTS). Anything else is denied.
 *
 * Disabled unless KITSUDEN_OPENSANDBOX_URL and KITSUDEN_OPENSANDBOX_IMAGE are
 * set (and code actions are enabled). Promotion never runs these tests in
 * OpenSandbox: a draft for this runtime always waits for a human.
 *
 * API facts from the project's `specs/sandbox-lifecycle.yml` and
 * `specs/execd-api.yaml` (2026-11). No code is copied.
 */

import { messageOf } from "@kitsuden/engine";
import { hostCovers } from "@kitsuden/shared";

import type { EgressRule } from "../egress-policy";
import type { SandboxResult } from "../worker-sandbox";

export type OpenSandboxLanguage = "python" | "shell";

export const OPENSANDBOX_RUNTIMES = ["opensandbox:python", "opensandbox:shell"] as const;
export type OpenSandboxRuntime = (typeof OPENSANDBOX_RUNTIMES)[number];

/** The runtimes a code action may name. `quickjs` is the default. */
export const CODE_RUNTIMES = ["quickjs", ...OPENSANDBOX_RUNTIMES] as const;

export function isOpenSandboxRuntime(r: unknown): r is OpenSandboxRuntime {
  return typeof r === "string" && (OPENSANDBOX_RUNTIMES as readonly string[]).includes(r);
}

export interface OpenSandboxConfig {
  baseUrl: string;
  apiKey: string | null;
  image: string;
  entrypoint: string[];
  /** execd port inside the sandbox. */
  execdPort: number;
  /** How long to wait for `Running`. */
  startTimeoutMs: number;
}

/** The operator's settings, or null when the runtime is not configured. */
export function openSandboxConfig(env: NodeJS.ProcessEnv = process.env): OpenSandboxConfig | null {
  const baseUrl = env.KITSUDEN_OPENSANDBOX_URL?.trim().replace(/\/+$/, "");
  const image = env.KITSUDEN_OPENSANDBOX_IMAGE?.trim();
  if (!baseUrl || !image) return null;
  let entrypoint = ["tail", "-f", "/dev/null"];
  if (env.KITSUDEN_OPENSANDBOX_ENTRYPOINT) {
    try {
      const parsed = JSON.parse(env.KITSUDEN_OPENSANDBOX_ENTRYPOINT);
      if (Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === "string"))
        entrypoint = parsed;
    } catch {
      /* keep the default */
    }
  }
  return {
    baseUrl,
    apiKey: env.KITSUDEN_OPENSANDBOX_API_KEY?.trim() || null,
    image,
    entrypoint,
    execdPort: Number(env.KITSUDEN_OPENSANDBOX_EXECD_PORT) || 44772,
    startTimeoutMs: Math.min(Number(env.KITSUDEN_OPENSANDBOX_START_TIMEOUT_MS) || 30_000, 120_000),
  };
}

export interface OpenSandboxInput {
  runtime: OpenSandboxRuntime;
  code: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  memoryLimitMb: number;
  /** The action layer of the egress policy (rules + fetchAllow hosts). */
  rules: EgressRule[];
  /** Hosts that may receive customer data for this action (KITSUDEN_CUSTOMER_DATA_HOSTS + its own). */
  customerDataHosts: string[];
  /** Label for the sandbox's metadata (no secrets). */
  actionId: string;
}

/** Is every host `target` covers allowed to receive customer data? */
function hostAllowedForCustomerData(target: string, list: string[]): boolean {
  return list.some((p) => hostCovers(p.trim().toLowerCase(), target));
}

/**
 * The network policy sent to OpenSandbox: deny by default; allow only domain
 * rules (OpenSandbox refuses domain + ports) whose host may also receive
 * customer data. IP/CIDR and port-only allows are dropped (they cannot be
 * checked against the customer-data list). Deny rules with a domain or IP
 * target are passed through.
 */
export function networkPolicyFor(rules: EgressRule[], customerDataHosts: string[]) {
  const egress: { action: "allow" | "deny"; target: string }[] = [];
  for (const r of rules) {
    if (!r.target || r.target === "*" || r.target.includes("/")) continue;
    if (r.action === "deny") {
      egress.push({ action: "deny", target: r.target });
    } else if (!r.ports?.length && hostAllowedForCustomerData(r.target, customerDataHosts)) {
      egress.push({ action: "allow", target: r.target });
    }
  }
  return { defaultAction: "deny" as const, egress };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The program that runs: the payload arrives as `event` (Python) or `$EVENT_JSON` (shell). */
export function programFor(
  runtime: OpenSandboxRuntime,
  code: string,
  payload: unknown
): {
  path: "/code" | "/command";
  body: Record<string, unknown>;
} {
  const event = JSON.stringify(payload ?? {});
  if (runtime === "opensandbox:python") {
    const prelude = `import json as __j, base64 as __b\nevent = __j.loads(__b.b64decode("${b64(event)}").decode("utf-8"))\n`;
    return { path: "/code", body: { code: prelude + code } };
  }
  return { path: "/command", body: { command: code, envs: { EVENT_JSON: event } } };
}

interface StreamOutcome {
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
}

/** Parses execd's server-sent events (unknown types are ignored, as the spec asks). */
export function parseExecdStream(text: string, maxBytes = 1_000_000): StreamOutcome {
  const out: StreamOutcome = { stdout: "", stderr: "", result: null, error: null };
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    const raw = data || (block.trim().startsWith("{") ? block.trim() : "");
    if (!raw) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    const t = ev.type;
    if (t === "stdout" && typeof ev.text === "string") out.stdout += ev.text;
    else if (t === "stderr" && typeof ev.text === "string") out.stderr += ev.text;
    else if (t === "result" && ev.results && typeof ev.results === "object") {
      const plain = (ev.results as Record<string, unknown>)["text/plain"];
      if (typeof plain === "string") out.result = plain;
    } else if (t === "error" && ev.error && typeof ev.error === "object") {
      const e = ev.error as { ename?: unknown; evalue?: unknown; exit_code?: unknown };
      out.error =
        [e.ename, e.evalue].filter((x) => typeof x === "string" && x).join(": ") ||
        (typeof e.exit_code === "number" ? `exit code ${e.exit_code}` : "error");
    }
    if (out.stdout.length + out.stderr.length > maxBytes) {
      out.error ??= "Output too large";
      break;
    }
  }
  return out;
}

type Fetch = typeof fetch;

/**
 * Runs one execution. `fetchImpl` is injectable for tests. The sandbox is
 * deleted in every case, including errors and timeouts.
 */
export async function runInOpenSandbox(
  input: OpenSandboxInput,
  cfg: OpenSandboxConfig,
  fetchImpl: Fetch = fetch
): Promise<SandboxResult> {
  const started = performance.now();
  const duration = () => Math.round(performance.now() - started);
  const fail = (
    error: string,
    exitReason: SandboxResult["exitReason"] = "error"
  ): SandboxResult => ({
    success: false,
    result: null,
    logs: "",
    error,
    durationMs: duration(),
    memoryUsedBytes: 0,
    exitReason,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["OPEN-SANDBOX-API-KEY"] = cfg.apiKey;
  const deadline =
    Date.now() + Math.min(Math.max(input.timeoutMs, 1000), 60_000) + cfg.startTimeoutMs;
  const remaining = () => Math.max(deadline - Date.now(), 1);
  let sandboxId: string | null = null;

  try {
    const created = await fetchImpl(`${cfg.baseUrl}/sandboxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        image: { uri: cfg.image },
        entrypoint: cfg.entrypoint,
        // The lifecycle API's minimum is 60 s; the sandbox is deleted as soon as we finish.
        timeout: Math.max(60, Math.ceil(remaining() / 1000) + 30),
        resourceLimits: {
          cpu: "1",
          memory: `${Math.min(Math.max(input.memoryLimitMb, 64), 2048)}Mi`,
        },
        env: {},
        metadata: { "kitsuden.action": input.actionId.slice(0, 63) },
        networkPolicy: networkPolicyFor(input.rules, input.customerDataHosts),
      }),
      signal: AbortSignal.timeout(remaining()),
    });
    if (!created.ok)
      return fail(`OpenSandbox refused to create the sandbox (HTTP ${created.status})`);
    const sandbox = (await created.json()) as { id?: unknown; status?: { state?: unknown } };
    if (typeof sandbox.id !== "string" || !sandbox.id)
      return fail("OpenSandbox returned no sandbox id");
    sandboxId = sandbox.id;
    const id = encodeURIComponent(sandboxId);

    let state = typeof sandbox.status?.state === "string" ? sandbox.status.state : "Pending";
    while (state !== "Running") {
      if (state === "Failed" || state === "Terminated")
        return fail(`The sandbox did not start (${state})`, "killed");
      if (Date.now() >= deadline) return fail("The sandbox did not start in time", "timeout");
      await new Promise((r) => setTimeout(r, 250));
      const s = await fetchImpl(`${cfg.baseUrl}/sandboxes/${id}`, {
        headers,
        signal: AbortSignal.timeout(remaining()),
      });
      if (!s.ok) return fail(`OpenSandbox status check failed (HTTP ${s.status})`);
      const body = (await s.json()) as { status?: { state?: unknown } };
      state = typeof body.status?.state === "string" ? body.status.state : "Pending";
    }

    const ep = await fetchImpl(`${cfg.baseUrl}/sandboxes/${id}/endpoints/${cfg.execdPort}`, {
      headers,
      signal: AbortSignal.timeout(remaining()),
    });
    if (!ep.ok) return fail(`OpenSandbox gave no execd endpoint (HTTP ${ep.status})`);
    const endpoint = (await ep.json()) as { endpoint?: unknown; headers?: unknown };
    if (typeof endpoint.endpoint !== "string" || !endpoint.endpoint)
      return fail("OpenSandbox gave no execd endpoint");
    const execdBase = /^https?:\/\//.test(endpoint.endpoint)
      ? endpoint.endpoint.replace(/\/+$/, "")
      : `${new URL(cfg.baseUrl).protocol}//${endpoint.endpoint.replace(/\/+$/, "")}`;
    const execdHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (endpoint.headers && typeof endpoint.headers === "object") {
      for (const [k, v] of Object.entries(endpoint.headers as Record<string, unknown>)) {
        if (typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(k)) execdHeaders[k] = v;
      }
    }

    const program = programFor(input.runtime, input.code, input.payload);
    const runBody =
      program.path === "/command" ? { ...program.body, timeout: input.timeoutMs } : program.body;
    const run = await fetchImpl(`${execdBase}${program.path}`, {
      method: "POST",
      headers: execdHeaders,
      body: JSON.stringify(runBody),
      signal: AbortSignal.timeout(Math.min(remaining(), input.timeoutMs + 5000)),
    });
    if (!run.ok) return fail(`execd refused the run (HTTP ${run.status})`);
    const outcome = parseExecdStream(await run.text());
    const logs = [outcome.stdout, outcome.stderr && `[stderr]\n${outcome.stderr}`]
      .filter(Boolean)
      .join("\n")
      .slice(0, 50_000);
    if (outcome.error) return { ...fail(outcome.error), logs };
    let result: unknown = outcome.result ?? outcome.stdout.trim().split("\n").pop() ?? null;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        /* plain text */
      }
    }
    return {
      success: true,
      result,
      logs,
      error: null,
      durationMs: duration(),
      memoryUsedBytes: 0,
      exitReason: "success",
    };
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail(
      timedOut
        ? `Function timed out after ${input.timeoutMs}ms`
        : `OpenSandbox error: ${messageOf(err)}`,
      timedOut ? "timeout" : "error"
    );
  } finally {
    if (sandboxId) {
      await fetchImpl(`${cfg.baseUrl}/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }
}
