/**
 * Reading and splitting SQL files.
 * ============================================================================
 *
 * There is a single copy of this on purpose: the migration runner and the
 * RLS applier have to split the same way, and two copies diverge.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Splits a SQL file into statements, respecting dollar-tagged bodies
 * (`$$ … $$`, `$POLICY$ … $POLICY$`).
 *
 * Splitting by `;` is not enough: `DO $$` blocks and function bodies carry
 * `;` inside, and splitting there hands them to Postgres broken.
 *
 * And counting markers is not enough either —which is what the previous version did in
 * apply-rls.ts—: if a `$$` appears inside a `$POLICY$`, the counter
 * gets out of sync and from then on the whole file is split wrongly. You have to
 * remember WHICH tag opened and close only with that same one.
 */
export function splitStatements(raw: string): string[] {
  // drizzle-kit marks the boundaries explicitly. When they are present, they are used: its
  // lines end in `;--> statement-breakpoint`, not in `;`, so the
  // heuristic below saw the whole file as ONE statement and
  // handed it to Postgres in one piece.
  if (raw.includes("--> statement-breakpoint")) {
    return raw
      .split("--> statement-breakpoint")
      .map((s) => removeComments(s).trim())
      .filter((s) => s.length > 0);
  }

  const statements: string[] = [];
  let buffer = "";
  let openTag: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    // Comments and blank lines outside a body: they are discarded so that
    // the stored statement is the SQL and nothing else.
    if (!openTag && (trimmed === "" || trimmed.startsWith("--"))) continue;

    buffer += line + "\n";

    for (const mark of line.match(/\$[A-Za-z_]*\$/g) ?? []) {
      if (openTag === null) openTag = mark;
      else if (mark === openTag) openTag = null;
      // A different tag inside an open body is content, not a
      // delimiter. Ignoring it is exactly what fixes the mismatch.
    }

    // It is compared WITHOUT the trailing comment: a line like
    // `ALTER TABLE x FORCE ROW LEVEL SECURITY; -- note` does not end in `;`, so
    // without this it was not cut and the statement merged with the next one.
    if (!openTag && withoutFinalComment(trimmed).endsWith(";")) {
      statements.push(buffer.trim());
      buffer = "";
    }
  }

  // A last statement without a final `;` is still valid for Postgres.
  const rest = buffer.trim();
  if (rest) statements.push(rest);

  return statements;
}

/**
 * Trims the trailing `--` comment of a line, only to decide whether the
 * statement ends there.
 *
 * A `--` inside a string is NOT a comment: `SELECT '-- no';` would still
 * be the same line. This is told apart by counting the preceding single quotes
 * —even number = we are outside a string— and treating `''` as an escaped quote,
 * which is how Postgres writes them.
 */
function withoutFinalComment(line: string): string {
  let inChain = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      // `''` inside a string is a literal quote, not its closing.
      if (inChain && line[i + 1] === "'") {
        i++;
        continue;
      }
      inChain = !inChain;
    } else if (!inChain && c === "-" && line[i + 1] === "-") {
      return line.slice(0, i).trimEnd();
    }
  }

  return line;
}

/**
 * Removes whole-line comments, keeping those at the end of
 * a line with SQL (which may be part of a dollar-tagged body).
 */
function removeComments(block: string): string {
  return block
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

export interface SqlFile {
  /** File name, which is the key in the migration history. */
  name: string;
  path: string;
  raw: string;
  /** sha256 of the content: detects that an already applied migration changed. */
  checksum: string;
  statements: string[];
}

export function readSqlFile(path: string, name: string): SqlFile {
  const raw = readFileSync(path, "utf8");
  return {
    name,
    path,
    raw,
    checksum: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    statements: splitStatements(raw),
  };
}
