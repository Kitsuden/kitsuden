/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BRAIN COMMANDS — Second Brain (Karpathy method) from the CLI
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lets humans and AI agents operating from a terminal manage the
 * project's second brain via the API:
 *
 *   kitsuden brain schema                       # prints BRAIN.md (Layer 3)
 *   kitsuden brain lint                         # deterministic health check
 *   kitsuden brain sources                      # lists sources (Layer 1)
 *   kitsuden brain capture --title X --content Y [--file f] [--author instruction|api|cli]
 *   kitsuden brain sync [--force] [--author ...]
 *   kitsuden brain digest [--days 7] [--author ...]
 *
 * Per-environment config:
 *   KITSUDEN_API_URL    (default http://localhost:3000)
 *   KITSUDEN_API_TOKEN  (Bearer for protected endpoints: capture/sync/digest)
 */

import fs from "node:fs/promises";

import chalk from "chalk";

interface BrainOptions {
  title?: string;
  content?: string;
  file?: string;
  author?: "instruction" | "api" | "cli";
  days?: string;
  force?: boolean;
}

function apiBase(): string {
  return process.env.KITSUDEN_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

function authHeaders(): Record<string, string> {
  const token = process.env.KITSUDEN_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export async function brainCommand(action: string, options: BrainOptions = {}): Promise<void> {
  try {
    switch (action) {
      case "schema": {
        const res = await apiFetch("/api/brain/schema");
        const md = await res.text();
        if (options.file || options.force) {
          const target = options.file ?? "BRAIN.md";
          await fs.writeFile(target, md, "utf8");
          console.log(chalk.green(`✅ ${target} written (${md.length} chars)`));
        } else {
          console.log(md);
        }
        break;
      }

      case "lint": {
        const res = await apiFetch("/api/brain/lint");
        const report = (await res.json()) as any;
        console.log(chalk.cyan("\n🧠 Brain Lint\n"));
        console.log(`  Total notes:     ${report.totalNotes}`);
        console.log(`  Broken links:    ${report.brokenLinks?.length ?? 0}`);
        console.log(`  Orphaned:        ${report.orphanNotes?.length ?? 0}`);
        console.log(`  Stale (pending): ${report.staleNotes?.length ?? 0}`);
        console.log(`  Duplicates:      ${report.duplicateTitles?.length ?? 0}`);
        console.log(`  Thin:            ${report.thinNotes?.length ?? 0}`);
        console.log(
          report.healthy
            ? chalk.green("\n  ✅ Healthy wiki\n")
            : chalk.yellow("\n  ⚠️  Needs attention\n")
        );
        break;
      }

      case "sources": {
        const res = await apiFetch("/api/brain/sources");
        const { sources } = (await res.json()) as any;
        console.log(chalk.cyan(`\n🧠 Sources (${sources?.length ?? 0})\n`));
        for (const s of sources ?? []) {
          console.log(`  ${chalk.white(s.title)} ${chalk.gray(`[${s.sourceType}] ${s.id}`)}`);
        }
        console.log("");
        break;
      }

      case "capture": {
        let content = options.content;
        if (options.file) content = await fs.readFile(options.file, "utf8");
        if (!options.title || !content) {
          console.error(chalk.red("capture requires --title and (--content or --file)"));
          process.exit(1);
        }
        const res = await apiFetch("/api/brain/capture", {
          method: "POST",
          body: JSON.stringify({
            title: options.title,
            content,
            author: options.author,
          }),
        });
        const result = (await res.json()) as any;
        if (!res.ok) {
          console.error(chalk.red(`Error ${res.status}: ${JSON.stringify(result)}`));
          process.exit(1);
        }
        console.log(chalk.green("\n✅ Captured\n"));
        console.log(`  Source:      ${result.sourceId}${result.deduped ? " (dedup)" : ""}`);
        console.log(`  Page:        ${result.noteId}`);
        console.log(`  Author:      ${result.authoredBy}`);
        console.log(`  Connections: ${result.connectionsCreated}`);
        if (result.pendingAgent) {
          console.log(chalk.yellow("  ⏳ Contains AGENT-TASK: an AI must complete the prose.\n"));
        } else {
          console.log("");
        }
        break;
      }

      case "sync": {
        const params = new URLSearchParams();
        if (options.force) params.set("force", "true");
        if (options.author) params.set("author", options.author);
        const res = await apiFetch(`/api/brain/sync?${params}`, { method: "POST" });
        const result = (await res.json()) as any;
        console.log(chalk.green("\n🔄 Sync\n"));
        console.log(`  Sources:       ${result.sourcesTotal}`);
        console.log(`  New pages:      ${result.notesCreated}`);
        console.log(`  Up to date:    ${result.notesUpToDate}`);
        if (result.errors?.length) console.log(chalk.yellow(`  Errors:  ${result.errors.length}`));
        console.log("");
        break;
      }

      case "digest": {
        const params = new URLSearchParams();
        if (options.days) params.set("days", options.days);
        if (options.author) params.set("author", options.author);
        const res = await apiFetch(`/api/brain/digest?${params}`, { method: "POST" });
        const result = (await res.json()) as any;
        console.log(
          chalk.cyan(`\n📰 Digest (${result.notesConsidered} notes, author ${result.authoredBy})\n`)
        );
        console.log(result.markdown);
        console.log("");
        break;
      }

      default:
        console.error(
          chalk.red(
            `Unknown action: '${action}'. Use: schema | lint | sources | capture | sync | digest`
          )
        );
        process.exit(1);
    }
  } catch (err) {
    console.error(chalk.red(`Failed to reach the API at ${apiBase()}: ${(err as Error).message}`));
    console.error(chalk.gray("Is the API running? (kitsuden dev / kitsuden start)"));
    process.exit(1);
  }
}
