import { execSync } from "child_process";
import path from "path";

import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";

async function isRailwayProject(projectRoot: string): Promise<boolean> {
  return (
    fs.existsSync(path.join(projectRoot, "railway.json")) ||
    !!process.env.RAILWAY_PROJECT_ID ||
    !!process.env.RAILWAY_TOKEN
  );
}

async function getRailwayStatus(projectRoot: string): Promise<{
  name?: string;
  url?: string;
  status?: string;
} | null> {
  try {
    const statusOutput = execSync("railway status", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    const lines = statusOutput.split("\n");
    const result: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^\s*(.+?):\s*(.+)$/);
      if (match) {
        result[match[1].trim().toLowerCase()] = match[2].trim();
      }
    }

    // Try to get domain
    let url: string | undefined;
    try {
      const domainOutput = execSync("railway domain", {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const domain = domainOutput.trim();
      if (domain) url = `https://${domain}`;
    } catch {
      // ignore
    }

    return {
      name: result.project || result.name,
      url,
      status: result.status || "unknown",
    };
  } catch {
    return null;
  }
}

export async function statusCommand() {
  const spinner = ora("Checking status...").start();

  try {
    const projectRoot = process.cwd();
    const hasDockerCompose = await fs.pathExists(path.join(projectRoot, "docker-compose.yml"));
    const isRailway = await isRailwayProject(projectRoot);

    spinner.stop();

    console.log(chalk.cyan("\n📊 Kitsuden Status\n"));

    // ── Railway status ──
    if (isRailway) {
      const railwayStatus = await getRailwayStatus(projectRoot);
      if (railwayStatus) {
        console.log(chalk.green("  🚂 Railway Deployment\n"));
        console.log(`  ${chalk.white("Project:")} ${chalk.cyan(railwayStatus.name || "Unknown")}`);
        console.log(
          `  ${chalk.white("Status:")}  ${chalk.green(railwayStatus.status || "active")}`
        );
        if (railwayStatus.url) {
          console.log(`  ${chalk.white("URL:")}    ${chalk.cyan(railwayStatus.url)}`);
        }
        console.log("");
      } else {
        console.log(chalk.yellow("  ⚠️  Railway project detected but status unavailable"));
        console.log(chalk.gray("     Run 'railway status' manually to diagnose\n"));
      }
    }

    // ── Docker / Local status ──
    if (hasDockerCompose) {
      try {
        const output = execSync("docker compose ps --format json", {
          cwd: projectRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        });

        const containers = JSON.parse(output || "[]");

        if (containers.length === 0) {
          console.log(chalk.yellow("  ⚠️  No local containers running"));
          console.log(chalk.gray("     Run: kitsuden start\n"));
        } else {
          console.log(chalk.green("  🟢 Local Services:\n"));

          const services = [
            { name: "kitsuden_api", label: "API Server", url: "http://localhost:3000" },
            { name: "kitsuden_admin", label: "Admin Panel", url: "http://localhost:3001" },
            { name: "kitsuden_mcp", label: "MCP Server", url: "http://localhost:3002" },
            { name: "kitsuden_db", label: "Database", url: "localhost:5432" },
            { name: "kitsuden_cache", label: "Cache", url: "localhost:6379" },
          ];

          for (const service of services) {
            const container = containers.find(
              (c: any) => c.Service === service.name || c.Name?.includes(service.name)
            );
            if (container) {
              const status = container.State === "running" ? chalk.green("●") : chalk.red("●");
              console.log(`  ${status} ${service.label.padEnd(15)} ${chalk.gray(service.url)}`);
            } else {
              console.log(
                `  ${chalk.gray("○")} ${service.label.padEnd(15)} ${chalk.gray("stopped")}`
              );
            }
          }
          console.log("");
        }
      } catch {
        console.log(chalk.yellow("  ⚠️  Docker not available or no containers\n"));
      }
    }

    // ── Project info ──
    const packageJson = await fs.readJson(path.join(projectRoot, "package.json")).catch(() => ({}));
    console.log(chalk.cyan("  📁 Project: ") + chalk.white(packageJson.name || "Unknown"));
    console.log(chalk.cyan("  🔧 Version: ") + chalk.white(packageJson.version || "0.1.0"));
    console.log("");
  } catch (error) {
    spinner.fail(chalk.red("Failed to check status"));
    console.error(error);
    process.exit(1);
  }
}
