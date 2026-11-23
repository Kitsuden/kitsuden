import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Writes a secret a seed script generated (a password, a token) to
 * `<cwd>/.kitsuden/<name>` with mode 0600, and returns the path. The scripts print
 * the path, never the secret: console output ends up in CI logs and terminal
 * scrollback. `.kitsuden/` is in `.gitignore` at any depth.
 */
export function writeSecretFile(name: string, contents: string, cwd = process.cwd()): string {
  const dir = join(cwd, ".kitsuden");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, contents.endsWith("\n") ? contents : `${contents}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created: tighten one left by an earlier run.
  chmodSync(path, 0o600);
  return path;
}
