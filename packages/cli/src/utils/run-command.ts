/**
 * Run external programs without a shell.
 *
 * Every command in the CLI goes through here so that no CLI argument, kon id or
 * path is ever parsed by `sh` or `cmd.exe`.
 *
 * Windows is the one awkward case: `pnpm` and friends are often `.cmd` shims,
 * and Node refuses to start those without a shell (CVE-2024-27980). So the
 * command is resolved through PATH and PATHEXT first. A real `.exe` starts
 * directly. A `.cmd` or `.bat` has to go through `cmd.exe`, and there the
 * arguments are checked against a strict allowlist first: anything `cmd.exe`
 * could read as syntax is refused, not quoted.
 */

import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Characters with no meaning to cmd.exe. `%`, `&`, `|`, `<`, `>`, `^`, quotes and spaces are out. */
const SAFE_CMD_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\-]+$/;

export class UnsafeArgumentError extends Error {}

export interface Invocation {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export interface PlatformContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The file PATH and PATHEXT resolve a command to on Windows, or null. */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** How to start `command args…` without a shell parsing the arguments. */
export function buildInvocation(
  command: string,
  args: string[],
  context: PlatformContext = {}
): Invocation {
  const platform = context.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args, windowsVerbatimArguments: false };

  const env = context.env ?? process.env;
  const resolved = resolveWindowsCommand(command, env);
  if (!resolved) return { file: command, args, windowsVerbatimArguments: false };
  if (!/\.(cmd|bat)$/i.test(resolved))
    return { file: resolved, args, windowsVerbatimArguments: false };

  const unsafe = args.find((a) => !SAFE_CMD_ARGUMENT.test(a));
  if (unsafe !== undefined) {
    throw new UnsafeArgumentError(
      `Refusing to pass ${JSON.stringify(unsafe)} to ${command}: it runs through cmd.exe on this machine.`
    );
  }
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `""${resolved}" ${args.join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Runs a command to completion. Returns its exit code (1 if it could not start). */
export function runCommandSync(command: string, args: string[], options: RunOptions = {}): number {
  const invocation = buildInvocation(command, args, { env: options.env });
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? "inherit",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return result.status ?? 1;
}

/** Starts a command and hands back the child process. */
export function spawnCommand(
  command: string,
  args: string[],
  options: RunOptions & { detached?: boolean } = {}
): ChildProcess {
  const invocation = buildInvocation(command, args, { env: options.env });
  return spawn(invocation.file, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? "inherit",
    detached: options.detached ?? false,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

/** Opens a file in the desktop's default application. No shell on any platform. */
export function openWithDefaultApp(file: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", file]]
      : process.platform === "darwin"
        ? ["open", [file]]
        : ["xdg-open", [file]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => {
    console.error(`Could not open the file automatically. Open it yourself: ${file}`);
  });
  child.unref();
}
