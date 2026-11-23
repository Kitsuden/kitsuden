/**
 * One-line Markdown ATX heading: `## Title`.
 *
 * Replaces `/^(#{1,6})\s+(.+?)\s*$/`, whose three adjacent whitespace-matching
 * parts made a line of many spaces quadratic. Only the `#` prefix is matched by
 * regex; the title is the rest of the line, trimmed.
 */
const PREFIX = /^(#{1,6})\s/;

export interface MarkdownHeading {
  level: number;
  title: string;
}

export function parseHeading(line: string): MarkdownHeading | null {
  const m = PREFIX.exec(line);
  if (!m) return null;
  const title = line.slice(m[1].length).trim();
  return title ? { level: m[1].length, title } : null;
}
