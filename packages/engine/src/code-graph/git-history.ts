/**
 * Kitsuden — Code Graph: Git history (Sourcegraph-style, read-only)
 * ============================================================================
 *
 * History primitives for agents: commit search, history of a
 * file and summary of a commit. All through the `git` CLI in read-only mode;
 * deterministic given the repo state.
 *
 * If `git` is not available or the directory is not a repo, it returns empty
 * lists (clean degradation, same as system-map without a DB).
 */

import { execFileSync } from "node:child_process";

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface CommitSearchOptions {
  /** Text to search for in commit messages (git log --grep). */
  grep?: string;
  /** Limit to commits that touch this path. */
  path?: string;
  author?: string;
  limit?: number;
}

const FORMAT = "%H%x1f%an%x1f%aI%x1f%s";

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

function parseLog(raw: string): CommitInfo[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject] = line.split("\x1f");
      return { sha, author, date, subject };
    })
    .filter((c) => c.sha && c.subject !== undefined);
}

/** Searches commits by message/author/path. */
export function commitSearch(root: string, options: CommitSearchOptions = {}): CommitInfo[] {
  const args = ["log", `--format=${FORMAT}`, `-n`, String(options.limit ?? 20)];
  if (options.grep) args.push("--grep", options.grep, "-i");
  if (options.author) args.push("--author", options.author);
  if (options.path) args.push("--", options.path);
  return parseLog(runGit(root, args));
}

/** History of a file (follows renames). */
export function fileHistory(root: string, path: string, limit = 20): CommitInfo[] {
  return parseLog(
    runGit(root, ["log", `--format=${FORMAT}`, "-n", String(limit), "--follow", "--", path])
  );
}

export interface CommitDetail extends CommitInfo {
  /** Touched files with line counts: "12\t3\tpath". */
  files: { path: string; added: number; removed: number }[];
}

/** Detail of a commit: metadata + touched files (without the full patch). */
export function commitShow(root: string, sha: string): CommitDetail | null {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return null;
  const meta = parseLog(runGit(root, ["log", "-1", `--format=${FORMAT}`, sha]));
  if (meta.length === 0) return null;
  const numstat = runGit(root, ["show", "--numstat", "--format=", sha]);
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split("\t");
      return {
        path: path ?? "",
        added: Number.parseInt(added, 10) || 0,
        removed: Number.parseInt(removed, 10) || 0,
      };
    })
    .filter((f) => f.path);
  return { ...meta[0], files };
}
