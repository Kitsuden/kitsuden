import path from "path";

import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";

import { spawnCommand } from "../utils/run-command.js";

interface LogsOptions {
  follow?: boolean;
  service?: string;
}

export async function logsCommand(options: LogsOptions) {
  const spinner = ora("Fetching logs...").start();

  try {
    const projectRoot = process.cwd();
    const hasDockerCompose = await fs.pathExists(path.join(projectRoot, "docker-compose.yml"));

    if (!hasDockerCompose) {
      spinner.fail(chalk.red("No Kitsuden project found in current directory."));
      process.exit(1);
    }

    spinner.stop();

    const args = ["compose", "logs"];

    if (options.follow) {
      args.push("-f");
    }

    if (options.service) {
      const serviceMap: Record<string, string> = {
        api: "kitsuden_api",
        admin: "kitsuden_admin",
        db: "kitsuden_db",
        cache: "kitsuden_state",
      };
      args.push("--", serviceMap[options.service] || options.service);
    }

    console.log(chalk.cyan(`\n📋 Logs ${options.follow ? "(following...)" : ""}\n`));

    spawnCommand("docker", args, { cwd: projectRoot, stdio: "inherit" });
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch logs"));
    console.error(error);
    process.exit(1);
  }
}
