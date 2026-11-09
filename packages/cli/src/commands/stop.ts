import { execSync } from "child_process";
import path from "path";

import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";

export async function stopCommand() {
  const spinner = ora("Stopping Kitsuden services...").start();

  try {
    const projectRoot = process.cwd();
    const hasDockerCompose = await fs.pathExists(path.join(projectRoot, "docker-compose.yml"));

    if (!hasDockerCompose) {
      spinner.fail(chalk.red("No Kitsuden project found in current directory."));
      process.exit(1);
    }

    execSync("docker compose down", {
      cwd: projectRoot,
      stdio: "pipe",
    });

    spinner.succeed(chalk.green("✅ All Kitsuden services stopped"));
    console.log(chalk.gray("\nContainers have been stopped and removed.\n"));
  } catch (error) {
    spinner.fail(chalk.red("Failed to stop Kitsuden"));
    console.error(error);
    process.exit(1);
  }
}
