/**
 * KITSUDEN Brain — WikiAuthor (Layer 2 authoring)
 * ============================================================================
 *
 * A `WikiAuthor` takes a source + deterministic signals (extraction.ts) and
 * produces the Markdown BODY of a wiki page. The pipeline around it
 * (which pages to touch, frontmatter, backlinks, connections) is 100% deterministic;
 * the author only writes the prose.
 *
 * Three providers, from the most deterministic to the most "AI":
 *
 *   1. instruction (DEFAULT) — ZERO AI, offline, deterministic byte for byte.
 *      Emits a structured page from the signals + an
 *      <!-- AGENT-TASK --> block with precise instructions so that a LOCAL AI
 *      (Claude Code, Cursor, Ollama with tools) completes the prose
 *      following BRAIN.md. It is the route by which "a local AI understands how to do it".
 *
 *   2. api — uses an LLM via API (Anthropic SDK, already a repo dependency).
 *      For "AIs consumed via API".
 *
 *   3. cli — invokes a binary (claude -p, ollama run, etc.) passing it a
 *      deterministic prompt and reading stdout. For "AIs consumed via CLI".
 *
 * Selection by environment: KITSUDEN_BRAIN_AUTHOR = instruction | api | cli
 */

import { spawn } from "node:child_process";

import type { ExtractionResult } from "./extraction";

// ── Contract ──────────────────────────────────────────────────────────────

export interface AuthorTask {
  /** Title of the source/page. */
  title: string;
  /** Raw content of the source (Layer 1). */
  content: string;
  /** Deterministic signals already extracted. */
  signals: ExtractionResult;
  /** Titles of related notes for readable cross-linking. */
  relatedTitles: string[];
  /** Vault rules (Layer 3 / BRAIN.md) the author must respect. */
  schemaRules: string;
}

export interface AuthorResult {
  /** Markdown body of the page (without frontmatter; the pipeline adds it). */
  markdown: string;
  /** Provider that generated the content. */
  authoredBy: string;
  /** true if the body still requires an AI to complete it (instruction mode). */
  pendingAgent: boolean;
}

export interface WikiAuthor {
  id: string;
  author(task: AuthorTask): Promise<AuthorResult>;
}

// ── Deterministic prompt (shared by api and cli) ──────────────────────────

/**
 * Builds the prompt DETERMINISTICALLY from the task. The same
 * task always produces the same prompt (key to reproducibility).
 */
export function buildAuthorPrompt(task: AuthorTask): string {
  const related =
    task.relatedTitles.length > 0
      ? task.relatedTitles.map((t) => `- [[${t}]]`).join("\n")
      : "- (none yet)";

  return [
    "You are the maintainer of a Karpathy-style brain wiki. Write the BODY",
    "in Markdown of a page that summarizes and interprets the source. Rules:",
    "",
    task.schemaRules,
    "",
    `# Source: ${task.title}`,
    "",
    "## Deterministic signals already extracted (respect them):",
    `- Extractive summary: ${task.signals.summary || "(empty)"}`,
    `- Keywords: ${task.signals.keywords.join(", ") || "(none)"}`,
    `- Headings: ${task.signals.headings.join(" | ") || "(none)"}`,
    `- Links: ${task.signals.links.join(" ") || "(none)"}`,
    "",
    "## Backlinks to cross-link (use [[Title]] syntax):",
    related,
    "",
    "## Raw content:",
    task.content.slice(0, 8000),
    "",
    "Return ONLY Markdown (no frontmatter, no ```). Start with a summary",
    "of 2-3 sentences and then sections with the key concepts and their backlinks.",
  ].join("\n");
}

// ── 1. Instruction author (deterministic, no AI) ────────────────────────────

/**
 * Renders a deterministic page + a task block that a local AI can
 * execute. No external calls. Output stable byte for byte.
 */
export function createInstructionAuthor(): WikiAuthor {
  return {
    id: "instruction",
    async author(task: AuthorTask): Promise<AuthorResult> {
      const { signals } = task;
      const backlinks =
        task.relatedTitles.length > 0
          ? task.relatedTitles.map((t) => `[[${t}]]`).join(", ")
          : "_(no relations yet)_";

      const keywordLine = signals.keywords.length ? signals.keywords.join(", ") : "_(none)_";
      const linksBlock = signals.links.length
        ? signals.links.map((l) => `- <${l}>`).join("\n")
        : "_(no links)_";

      const md = [
        `> **Summary:**${signals.summary || "_pending drafting_"}`,
        "",
        "## Key concepts",
        "",
        keywordLine,
        "",
        "## Backlinks",
        "",
        backlinks,
        "",
        "## Sources / links",
        "",
        linksBlock,
        "",
        "<!-- AGENT-TASK",
        "An AI (local, API or CLI) must complete this page following BRAIN.md:",
        "1. Rewrite the summary in 2-3 clear sentences.",
        "2. Expand each key concept into a paragraph, with backlinks [[...]].",
        "3. Do not invent data that is not in the raw source.",
        "4. When finished, remove this AGENT-TASK block.",
        "-->",
      ].join("\n");

      return { markdown: md, authoredBy: "instruction", pendingAgent: true };
    },
  };
}

// ── 2. API author (Anthropic SDK) ───────────────────────────────────────────

export interface ApiAuthorOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

/**
 * Author via the Anthropic API. Dynamic import so as not to couple the engine to the SDK
 * when this mode is not used.
 */
export function createApiAuthor(opts: ApiAuthorOptions = {}): WikiAuthor {
  return {
    id: "api",
    async author(task: AuthorTask): Promise<AuthorResult> {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Safe, deterministic degradation: if there is no key, it falls back to instruction.
        const fallback = await createInstructionAuthor().author(task);
        return { ...fallback, authoredBy: "api:no-key→instruction" };
      }

      // Dynamic import without coupling types: the SDK is a dependency of apps/api,
      // not of the engine. It is resolved at runtime when this mode is used.
      // @ts-ignore - optional module resolved at runtime by the host (apps/api)
      const mod: any = await import("@anthropic-ai/sdk");
      const Anthropic = mod.default ?? mod;
      const client = new Anthropic({ apiKey });
      const model = opts.model ?? "claude-haiku-4-5-20251001";

      const message: any = await client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        messages: [{ role: "user", content: buildAuthorPrompt(task) }],
      });

      const text = (message.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();

      return { markdown: text, authoredBy: `api:${model}`, pendingAgent: false };
    },
  };
}

// ── 3. CLI author (claude -p, ollama run, ...) ──────────────────────────────

export interface CliAuthorOptions {
  /** Base command, e.g. "claude" or "ollama". */
  command: string;
  /** Args; the prompt is passed via stdin unless a placeholder is indicated. */
  args?: string[];
  /** ms before aborting. */
  timeoutMs?: number;
}

/**
 * Author via CLI: passes the deterministic prompt through stdin and reads stdout.
 * Examples:
 *   { command: "claude", args: ["-p"] }
 *   { command: "ollama", args: ["run", "llama3.1"] }
 */
export function createCliAuthor(opts: CliAuthorOptions): WikiAuthor {
  return {
    id: "cli",
    async author(task: AuthorTask): Promise<AuthorResult> {
      const prompt = buildAuthorPrompt(task);
      const timeoutMs = opts.timeoutMs ?? 60_000;

      const text = await new Promise<string>((resolve, reject) => {
        const child = spawn(opts.command, opts.args ?? [], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`CLI author timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`CLI author exit ${code}: ${stderr.slice(0, 500)}`));
        });

        child.stdin.write(prompt);
        child.stdin.end();
      });

      return { markdown: text, authoredBy: `cli:${opts.command}`, pendingAgent: false };
    },
  };
}

// ── Environment selector ────────────────────────────────────────────────────

export type AuthorMode = "instruction" | "api" | "cli";

/**
 * Resolves the author according to config/environment. Default: instruction (deterministic,
 * offline, zero cost). The pipeline works identically with any author.
 */
export function resolveAuthor(
  mode?: AuthorMode,
  options?: { api?: ApiAuthorOptions; cli?: CliAuthorOptions }
): WikiAuthor {
  const selected = (
    mode ??
    (process.env.KITSUDEN_BRAIN_AUTHOR as AuthorMode) ??
    "instruction"
  ).trim();

  switch (selected) {
    case "api":
      return createApiAuthor(options?.api);
    case "cli":
      if (!options?.cli?.command) {
        // With no command configured, degrade to instruction instead of failing.
        return createInstructionAuthor();
      }
      return createCliAuthor(options.cli);
    case "instruction":
    default:
      return createInstructionAuthor();
  }
}
