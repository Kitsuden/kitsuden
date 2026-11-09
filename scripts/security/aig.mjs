#!/usr/bin/env node
/**
 * Red-teaming of Kitsuden's MCP with AI-Infra-Guard (Tencent Zhuque Lab)
 * ============================================================================
 *
 * Tool: https://github.com/Tencent/AI-Infra-Guard (Apache-2.0). Credits
 * and cost: docs/agents/red-teaming.md. Only its PyPI CLIs are used, with a
 * PINNED version; its web interface is NEVER deployed (it has no authentication).
 *
 *   node scripts/security/aig.mjs                      MCP code + skill
 *   node scripts/security/aig.mjs --target=kons      + ../kitsuden-kons/kons
 *   node scripts/security/aig.mjs --target=server  DYNAMIC scan of a running
 *        TEST MCP (KITSUDEN_AIG_URL + KITSUDEN_AIG_TOKEN)
 *   node scripts/security/aig.mjs --prescan-only    only AIG's regex
 *        pre-scan: no LLM, no key, nothing leaves the machine
 *
 * Targets (`--target=a,b`): code, skill, kons, server, all.
 * Output: SARIF 2.1.0 in `.aig/` (gitignored) and an on-screen summary.
 *
 * Variables:
 *   LLM_API_KEY      required except with --prescan-only
 *   AIG_BASE_URL     OpenAI-compatible endpoint (AIG's default: OpenRouter)
 *   AIG_MODEL        model for ALL phases (AIG's default,
 *                    deepseek/deepseek-v3.2-exp). AIG on its own uses two other,
 *                    more expensive models for "thinking" and "coding"
 *                    (gemini-2.5-pro, claude-sonnet-4.5) and its `-u` does NOT
 *                    redirect them: this script pins all four to the same endpoint
 *                    and model so that cost and code destination are one.
 *   KITSUDEN_KONS_DIR  where the kons are (default ../kitsuden-kons/kons)
 *   KITSUDEN_AIG_URL   TEST MCP for `server` (e.g. http://127.0.0.1:3941/api/mcp)
 *   KITSUDEN_AIG_TOKEN `kitsuden_agent_*` key of THAT test stack
 *
 * What leaves the machine: with a key, the code of the targets (or the
 * test server's responses) goes to the LLM endpoint. Do not run it
 * on code that cannot leave, nor against production: the `server`
 * target refuses any host that is not local and port 3000 (the
 * production API's).
 */

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned versions (see docs/agents/red-teaming.md before bumping them)
export const AIG_MCP_SCAN = "aig-mcp-scan==0.2.0";
export const AIG_SKILL_SCAN = "aig-skill-scan==0.2.2";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT = join(ROOT, ".aig");

/** The MCP server files (what is audited as "code"). */
export const MCP_CODE = [
  "apps/api/src/routes/mcp.ts",
  "apps/api/src/services/mcp-tools.ts",
  "apps/api/src/lib/operations-mcp.ts",
  "apps/api/src/lib/operations-openapi.ts",
  "apps/api/src/lib/approvals-mcp.ts",
  "apps/api/src/lib/problems-mcp.ts",
  "apps/api/src/lib/provenance.ts",
  "apps/api/src/lib/mcp-settings.ts",
  "apps/api/src/lib/formats.ts",
  "packages/mcp-server/src",
  "packages/mcp-server/package.json",
  "packages/mcp-server/README.md",
];

export function argsObject(argv) {
  const a = { targets: ["code", "skill"], prescanOnly: false };
  for (const x of argv) {
    if (x === "--prescan-only") a.prescanOnly = true;
    else if (x.startsWith("--target="))
      a.targets = x.slice("--target=".length).split(",").filter(Boolean);
    else if (x === "-h" || x === "--help") a.help = true;
    else throw new Error(`Unknown argument: ${x}`);
  }
  if (a.targets.includes("all")) a.targets = ["code", "skill", "kons", "server"];
  for (const o of a.targets) {
    if (!["code", "skill", "kons", "server"].includes(o)) throw new Error(`Unknown target: ${o}`);
  }
  return a;
}

/** Only a local MCP, and not the production API's port. */
export function validTestUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return "not a URL";
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return "only a LOCAL test stack";
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (port === "3000") return "port 3000 is the production API";
  return null;
}

function runOnce(cmd, args, env) {
  return new Promise((resolver) => {
    const child = spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
    child.on("close", (code) => resolver(code ?? 1));
    child.on("error", () => resolver(127));
  });
}

/** Environment for AIG: one endpoint and one model for all its phases. */
function aigEnvironment() {
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  const base = process.env.AIG_BASE_URL;
  const model = process.env.AIG_MODEL;
  for (const phase of ["DEFAULT", "THINKING", "CODING", "FAST"]) {
    if (base) env[`${phase}_BASE_URL`] = base;
    if (model) env[`${phase}_MODEL`] = model;
  }
  // Without AIG_MODEL, the specialized phases use AIG's main model
  if (!model)
    for (const phase of ["THINKING", "CODING", "FAST"])
      env[`${phase}_MODEL`] = "deepseek/deepseek-v3.2-exp";
  return env;
}

function codeCopy() {
  const dir = mkdtempSync(join(tmpdir(), "kitsuden-aig-"));
  for (const rel of MCP_CODE) {
    const from = join(ROOT, rel);
    if (existsSync(from)) cpSync(from, join(dir, rel), { recursive: true });
  }
  return dir;
}

function summarizeSarif(file) {
  if (!existsSync(file)) return `  (no ${file})`;
  try {
    const sarif = JSON.parse(readFileSync(file, "utf8"));
    const results = (sarif.runs ?? []).flatMap((r) => r.results ?? []);
    const byLevel = {};
    for (const r of results) byLevel[r.level ?? "none"] = (byLevel[r.level ?? "none"] ?? 0) + 1;
    return `  ${results.length} findings ${JSON.stringify(byLevel)} → ${file}`;
  } catch (e) {
    return `  Unreadable SARIF (${e.message}) → ${file}`;
  }
}

/** Pre-scan without an LLM: AIG's regular-expression module. */
const PRESCAN = `
import sys, importlib
sys.stdout.reconfigure(encoding="utf-8")
pre = importlib.import_module(sys.argv[1])
for target in sys.argv[2:]:
    print("=" * 70)
    print("TARGET", target)
    print(pre.pre_scan(target) or "(no hits)")
`;

async function main() {
  const a = argsObject(process.argv.slice(2));
  if (a.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }
  if (!a.prescanOnly && !process.env.LLM_API_KEY) {
    console.error(
      "LLM_API_KEY is missing. Without a key only --prescan-only works (see docs/agents/red-teaming.md)."
    );
    return 2;
  }
  mkdirSync(OUTPUT, { recursive: true });
  const env = aigEnvironment();
  const kons = process.env.KITSUDEN_KONS_DIR || resolve(ROOT, "..", "kitsuden-kons", "kons");
  const code = a.targets.includes("code") ? codeCopy() : null;
  const summary = [];
  let worst = 0;

  try {
    if (a.prescanOnly) {
      // The script in its own folder (not next to what is scanned) and Python in -I mode
      const dirDash = mkdtempSync(join(tmpdir(), "kitsuden-aig-pre-"));
      const script = join(dirDash, "prescan.py");
      writeFileSync(script, PRESCAN);
      try {
        const mcp = [code, a.targets.includes("kons") && existsSync(kons) ? kons : null].filter(
          Boolean
        );
        if (mcp.length) {
          const c = await runOnce(
            "uv",
            [
              "run",
              "--no-project",
              "--with",
              AIG_MCP_SCAN,
              "python",
              "-I",
              script,
              "mcp_scan.utils.pre_scan",
              ...mcp,
            ],
            env
          );
          worst = Math.max(worst, c);
        }
        if (a.targets.includes("skill")) {
          const c = await runOnce(
            "uv",
            [
              "run",
              "--no-project",
              "--with",
              AIG_SKILL_SCAN,
              "python",
              "-I",
              script,
              "skill_scan.utils.pre_scan",
              join(ROOT, "skills", "kitsuden"),
            ],
            env
          );
          worst = Math.max(worst, c);
        }
      } finally {
        rmSync(dirDash, { recursive: true, force: true });
      }
      return worst;
    }

    const common = ["--language", "en"];
    if (code) {
      const out = join(OUTPUT, "mcp-code.sarif.json");
      worst = Math.max(
        worst,
        await runOnce(
          "uvx",
          ["--from", AIG_MCP_SCAN, "aig-mcp-scan", "--repo", code, ...common, "-o", out],
          env
        )
      );
      summary.push(`MCP code:\n${summarizeSarif(out)}`);
    }
    if (a.targets.includes("kons")) {
      if (!existsSync(kons)) summary.push(`kons: does not exist ${kons} (KITSUDEN_KONS_DIR)`);
      else {
        const out = join(OUTPUT, "mcp-kons.sarif.json");
        worst = Math.max(
          worst,
          await runOnce(
            "uvx",
            ["--from", AIG_MCP_SCAN, "aig-mcp-scan", "--repo", kons, ...common, "-o", out],
            env
          )
        );
        summary.push(`kitsuden-kons:\n${summarizeSarif(out)}`);
      }
    }
    if (a.targets.includes("server")) {
      const url = process.env.KITSUDEN_AIG_URL ?? "";
      const bad = validTestUrl(url);
      if (bad) summary.push(`server: NOT scanned ${url || "(no KITSUDEN_AIG_URL)"}: ${bad}`);
      else if (!process.env.KITSUDEN_AIG_TOKEN)
        summary.push("server: KITSUDEN_AIG_TOKEN is missing (agent key of the test stack)");
      else {
        const out = join(OUTPUT, "mcp-server.sarif.json");
        const header = `Authorization:Bearer ${process.env.KITSUDEN_AIG_TOKEN}`;
        worst = Math.max(
          worst,
          await runOnce(
            "uvx",
            [
              "--from",
              AIG_MCP_SCAN,
              "aig-mcp-scan",
              "--server_url",
              url,
              "--header",
              header,
              ...common,
              "-o",
              out,
            ],
            env
          )
        );
        summary.push(`test MCP server (${url}):\n${summarizeSarif(out)}`);
      }
    }
    if (a.targets.includes("skill")) {
      const out = join(OUTPUT, "skill-kitsuden.sarif.json");
      worst = Math.max(
        worst,
        await runOnce(
          "uvx",
          [
            "--from",
            AIG_SKILL_SCAN,
            "aig-skill-scan",
            "--repo",
            join(ROOT, "skills", "kitsuden"),
            ...common,
            "-o",
            out,
          ],
          env
        )
      );
      summary.push(`skill kitsuden:\n${summarizeSarif(out)}`);
    }
  } finally {
    if (code) rmSync(code, { recursive: true, force: true });
  }
  console.log(`\n── AI-Infra-Guard (Tencent Zhuque Lab) ──\n${summary.join("\n")}`);
  return worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(e.message);
      process.exit(2);
    }
  );
}
