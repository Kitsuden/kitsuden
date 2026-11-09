import path from "path";

import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";

import { runCommandSync, spawnCommand } from "../utils/run-command.js";

interface StartOptions {
  detach?: boolean;
  port?: string;
  admin?: boolean;
}

export async function startCommand(options: StartOptions) {
  const spinner = ora("Checking project...").start();

  try {
    // Check if we're in a Kitsuden project
    const projectRoot = process.cwd();
    const hasDockerCompose = await fs.pathExists(path.join(projectRoot, "docker-compose.yml"));
    const hasKitsudenConfig = await fs.pathExists(path.join(projectRoot, "kitsuden.config.ts"));

    if (!hasDockerCompose && !hasKitsudenConfig) {
      spinner.fail(chalk.red('No Kitsuden project found. Run "kitsuden init" first.'));
      process.exit(1);
    }

    spinner.text = "Starting Kitsuden services...";

    // Build the docker compose command
    const composeArgs = ["compose", "-f", "docker-compose.yml", "up"];

    if (options.detach) {
      composeArgs.push("-d");
    }

    // Always start core services
    const services = ["kitsuden_db", "kitsuden_state", "kitsuden_api"];

    if (options.admin !== false) {
      services.push("kitsuden_admin");
    }
    composeArgs.push(...services);

    // Check if Docker is running
    if (runCommandSync("docker", ["info"], { stdio: "ignore" }) !== 0) {
      spinner.fail(chalk.red("Docker is not running. Please start Docker first."));
      console.log(chalk.yellow("\n💡 Tips:"));
      console.log("  - Docker Desktop: https://www.docker.com/products/docker-desktop");
      console.log("  - Or install Docker Engine for your OS");
      process.exit(1);
    }

    spinner.stop();

    console.log(chalk.cyan("\n🚀 Starting Kitsuden services:\n"));

    if (options.admin !== false) {
      console.log(chalk.green("  ✓ Admin Panel") + chalk.gray("   → http://localhost:3001"));
    }
    console.log(chalk.green("  ✓ API Server") + chalk.gray("    → http://localhost:3000"));
    console.log(chalk.green("  ✓ MCP Endpoint") + chalk.gray("  → http://localhost:3000/api/mcp"));
    console.log(chalk.green("  ✓ Database") + chalk.gray("      → localhost:5432"));
    console.log(chalk.green("  ✓ Cache") + chalk.gray("         → localhost:6379"));

    console.log(chalk.cyan("\n⏳ Starting containers...\n"));

    // Start services
    if (options.detach) {
      const status = runCommandSync("docker", composeArgs, { cwd: projectRoot });
      if (status !== 0) {
        console.error(chalk.red("✖ docker compose up failed."));
        process.exit(status);
      }
      console.log(chalk.green("✅ Services started in detached mode"));
      console.log(chalk.cyan("\n📋 Useful commands:"));
      console.log(chalk.white("  kitsuden logs -f     # View logs"));
      console.log(chalk.white("  kitsuden stop        # Stop services"));
      console.log(chalk.white("  kitsuden status      # Check status\n"));
    } else {
      const child = spawnCommand("docker", composeArgs, { cwd: projectRoot, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 1));
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to start Kitsuden"));
    console.error(error);
    process.exit(1);
  }
}
