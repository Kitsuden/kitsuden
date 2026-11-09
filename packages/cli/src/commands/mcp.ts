import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import chalk from "chalk";
import fs from "fs-extra";

import { spawnCommand } from "../utils/run-command.js";

interface McpOptions {
  port?: string;
  apiUrl?: string;
  ide?: string;
  stdio?: boolean;
  agentEnvFile?: string;
}

export async function mcpCommand(options: McpOptions) {
  const PORT = options.port || "3002";
  const API_URL = options.apiUrl || "http://localhost:3000";

  // --stdio: the MCP client launches this process; stdout is theirs, no spinner.
  // Order: --agent-env-file, then the environment, then --api-url. The environment beats
  // --api-url because the latter always carries a value (the default), and overriding it
  // would send the agent to localhost:3000 without being asked.
  if (options.stdio) {
    const ofTheFile = options.agentEnvFile ? readAgentEnvFile(options.agentEnvFile) : {};
    runStdio(
      ofTheFile.KITSUDEN_API_URL ?? process.env.KITSUDEN_API_URL ?? API_URL,
      ofTheFile.KITSUDEN_API_TOKEN
    );
    return;
  }

  // If --ide flag is set, just generate IDE config and exit
  if (options.ide) {
    generateIdeConfig(options.ide, PORT, API_URL);
    return;
  }

  // The standalone server over HTTP, on 127.0.0.1. The token stays out of argv:
  // the server reads KITSUDEN_API_TOKEN from the environment it inherits.
  runServer(process.env.KITSUDEN_API_URL ?? API_URL, [], { PORT }, () => printConnectionInfo(PORT));
}

/**
 * Where the server is: `KITSUDEN_MCP_ENTRY`, or `packages/mcp-server` searching
 * upward from the current directory (the monorepo), or next to this CLI.
 */
function findStandaloneEntry(): string | null {
  if (process.env.KITSUDEN_MCP_ENTRY) return process.env.KITSUDEN_MCP_ENTRY;
  const candidates: string[] = [];
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    candidates.push(path.join(dir, "packages", "mcp-server"));
    if (path.dirname(dir) === dir) break;
  }
  // dist/commands/mcp.js → packages/cli → packages/mcp-server
  candidates.push(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mcp-server")
  );
  for (const pkg of candidates) {
    for (const entry of ["dist/standalone.js", "src/standalone.ts"]) {
      const file = path.join(pkg, entry);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

const FILE_VARIABLES = ["KITSUDEN_API_URL", "KITSUDEN_API_TOKEN"] as const;

/**
 * `--agent-env-file`: for MCP clients that do not expand `${VAR}` and that, like the
 * reference SDK, only pass PATH, HOME and little else to the server (Antigravity).
 * The token lives in a file that no repository will upload: inside
 * an unignored one, a `git add .` would publish it (there are machines where the
 * home folder itself is a repository with a remote). Inside one it is accepted only
 * if that repository ignores it. `~` is expanded here because in JSON nobody
 * does. It is not called `--env-file` because Node 22 and Bun have an option with that
 * name and Node read it even when it came after the script.
 */
function readAgentEnvFile(route: string): Partial<Record<(typeof FILE_VARIABLES)[number], string>> {
  const file = path.resolve(route.replace(/^~(?=$|[\\/])/, os.homedir()));
  const fail = (reason: string): never => {
    console.error(`--agent-env-file ${file}: ${reason}`);
    process.exit(1);
  };
  if (!fs.existsSync(file)) fail("does not exist");
  // null when git exits with an error (outside a repository, or not ignored)
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", path.dirname(file), ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  if (
    git("rev-parse", "--is-inside-work-tree") === "true" &&
    git("check-ignore", "-q", "--", file) === null
  ) {
    fail(
      `is inside the git repository ${git("rev-parse", "--show-toplevel")} and not ignored there; ` +
        "move it out of every repository, or ignore it in that one"
    );
  }
  const vars: Partial<Record<(typeof FILE_VARIABLES)[number], string>> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    if ((FILE_VARIABLES as readonly string[]).includes(name)) {
      vars[name as (typeof FILE_VARIABLES)[number]] = value.replace(/^(['"])(.*)\1$/, "$2");
    } else {
      console.error(`--agent-env-file: ignoring ${name} (only ${FILE_VARIABLES.join(", ")})`);
    }
  }
  return vars;
}

/**
 * The token arrives through the environment (`KITSUDEN_API_TOKEN`) or `--agent-env-file`:
 * in `.mcp.json` you write `${KITSUDEN_API_TOKEN}` and each agent brings its
 * own. A `--token` would end up written in a configuration file.
 */
function runStdio(apiUrl: string, token?: string) {
  runServer(apiUrl, ["--stdio"], token ? { KITSUDEN_API_TOKEN: token } : {});
}

function runServer(
  apiUrl: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
  onStart?: () => void
) {
  const entry = findStandaloneEntry();
  if (!entry) {
    console.error(
      "Kitsuden MCP server not found. Run inside the Kitsuden monorepo, or set KITSUDEN_MCP_ENTRY " +
        "to packages/mcp-server/dist/standalone.js."
    );
    process.exit(1);
  }
  const env = { ...process.env, KITSUDEN_API_URL: apiUrl, ...extraEnv };
  const child = spawnCommand("bun", ["run", entry, ...args], { stdio: "inherit", env });
  child.on("error", (error) => {
    console.error(`Could not start bun (${error.message}). The MCP server runs on Bun.`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  onStart?.();
}

function printConnectionInfo(port: string) {
  console.log(chalk.cyan("\n═══════════════════════════════════════════"));
  console.log(chalk.green.bold("  🧙 Kitsuden MCP Server"));
  console.log(chalk.cyan("═══════════════════════════════════════════"));
  console.log("");
  console.log(chalk.white("  SSE:        ") + chalk.blue.underline(`http://localhost:${port}/sse`));
  console.log(
    chalk.white("  Health:     ") + chalk.blue.underline(`http://localhost:${port}/health`)
  );
  console.log(
    chalk.white("  IDE Config: ") + chalk.blue.underline(`http://localhost:${port}/ide-config`)
  );
  console.log("");
  console.log(chalk.cyan("  Quick IDE Setup:"));
  console.log(chalk.white("    kitsuden mcp --ide cursor"));
  console.log(chalk.white("    kitsuden mcp --ide claude"));
  console.log(chalk.white("    kitsuden mcp --ide vscode"));
  console.log("");
}

function generateIdeConfig(ide: string, port: string, apiUrl: string) {
  const sseUrl = `http://localhost:${port}/sse`;

  switch (ide.toLowerCase()) {
    case "cursor": {
      const config = {
        mcpServers: {
          kitsuden: {
            url: sseUrl,
          },
        },
      };
      const configPath = path.join(process.cwd(), ".cursor", "mcp.json");

      console.log(chalk.cyan("\n🎯 Cursor MCP Configuration"));
      console.log(chalk.dim(`File: ${configPath}\n`));

      // Try to create the file
      try {
        fs.ensureDirSync(path.dirname(configPath));

        // Merge with existing config if present
        let existing: any = {};
        if (fs.existsSync(configPath)) {
          existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        }

        const merged = {
          ...existing,
          mcpServers: {
            ...(existing.mcpServers || {}),
            ...config.mcpServers,
          },
        };

        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
        console.log(chalk.green(`✅ Written to ${configPath}`));
      } catch {
        console.log(chalk.yellow("⚠️  Could not write file. Copy this manually:\n"));
        console.log(JSON.stringify(config, null, 2));
      }
      break;
    }

    case "claude": {
      const config = {
        mcpServers: {
          kitsuden: {
            command: "kitsuden",
            args: ["mcp", "--stdio"],
            env: {
              KITSUDEN_API_URL: apiUrl,
              KITSUDEN_API_TOKEN: "<your-agent-key>",
            },
          },
        },
      };

      console.log(chalk.cyan("\n🤖 Claude Desktop Configuration"));
      console.log(
        chalk.dim("File: ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)")
      );
      console.log(chalk.dim("      %APPDATA%\\Claude\\claude_desktop_config.json (Windows)\n"));
      console.log(chalk.white(JSON.stringify(config, null, 2)));
      break;
    }

    case "vscode": {
      const config = {
        "mcp.servers": {
          kitsuden: {
            url: sseUrl,
          },
        },
      };

      console.log(chalk.cyan("\n📝 VS Code Configuration"));
      console.log(chalk.dim("Merge into: .vscode/settings.json\n"));
      console.log(chalk.white(JSON.stringify(config, null, 2)));
      break;
    }

    case "windsurf": {
      const config = {
        mcpServers: {
          kitsuden: {
            serverUrl: sseUrl,
          },
        },
      };

      console.log(chalk.cyan("\n🏄 Windsurf Configuration"));
      console.log(chalk.dim("File: ~/.codeium/windsurf/mcp_config.json\n"));
      console.log(chalk.white(JSON.stringify(config, null, 2)));
      break;
    }

    default:
      console.log(chalk.red(`Unknown IDE: ${ide}`));
      console.log(chalk.dim("Available: cursor, claude, vscode, windsurf"));
  }
}
