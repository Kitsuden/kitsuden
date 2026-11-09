/**
 * DEV Command - Start development server
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import chalk from "chalk";

import { spawnCommand } from "../utils/run-command.js";

interface DevOptions {
  port?: string;
  host?: string;
  apiOnly?: boolean;
  adminOnly?: boolean;
}

export async function devCommand(options: DevOptions) {
  console.log(chalk.blue("\n🚀 Starting Kitsuden development server...\n"));

  const projectRoot = process.cwd();

  // Check if we're in a Kitsuden project
  if (!existsSync(join(projectRoot, "apps", "api"))) {
    console.error(chalk.red("✖ Not in a Kitsuden project directory"));
    process.exit(1);
  }

  const env = {
    ...process.env,
    PORT: options.port || "3000",
    HOST: options.host || "localhost",
    NODE_ENV: "development",
  };

  if (options.apiOnly) {
    console.log(chalk.gray("Starting API server only...\n"));

    const api = spawnCommand("pnpm", ["--filter", "@kitsuden/api", "dev"], {
      cwd: projectRoot,
      stdio: "inherit",
      env,
    });

    process.on("SIGINT", () => {
      api.kill("SIGINT");
    });

    return;
  }

  if (options.adminOnly) {
    console.log(chalk.gray("Starting Admin UI only...\n"));

    const admin = spawnCommand("pnpm", ["--filter", "@kitsuden/admin", "dev"], {
      cwd: projectRoot,
      stdio: "inherit",
      env,
    });

    process.on("SIGINT", () => {
      admin.kill("SIGINT");
    });

    return;
  }

  // Start all services with pnpm dev
  const dev = spawnCommand("pnpm", ["dev"], {
    cwd: projectRoot,
    stdio: "inherit",
    env,
  });

  console.log(chalk.gray("\n  API:   http://localhost:3000"));
  console.log(chalk.gray("  Admin: http://localhost:3001"));
  console.log(chalk.gray("  Web:   http://localhost:3002\n"));

  process.on("SIGINT", () => {
    console.log(chalk.gray("\n\nShutting down..."));
    dev.kill("SIGINT");
  });
}
