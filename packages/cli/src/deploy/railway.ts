/**
 * Railway Deploy Provider
 *
 * Deploys Kitsuden projects to Railway.app using the official CLI.
 * Supports both Nixpacks auto-detection and Dockerfile builds.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import chalk from "chalk";
import { execa } from "execa";
import ora from "ora";

interface RailwayDeployOptions {
  preview?: boolean;
  prod?: boolean;
  region?: string;
}

async function isRailwayCliInstalled(): Promise<boolean> {
  try {
    await execa("railway", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function isRailwayProjectLinked(projectRoot: string): Promise<boolean> {
  try {
    const result = await execa("railway", ["status"], { cwd: projectRoot });
    return result.exitCode === 0 && result.stdout.includes("Project");
  } catch {
    return false;
  }
}

async function readEnvFile(projectRoot: string): Promise<Record<string, string>> {
  const envPath = join(projectRoot, ".env");
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;

  const content = await readFile(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return vars;
}

export interface RailwayDeployResult {
  success: boolean;
  url?: string | null;
}

export async function deployToRailway(
  projectRoot: string,
  options: RailwayDeployOptions
): Promise<RailwayDeployResult> {
  console.log(chalk.blue("\n🚀 Deploying to Railway...\n"));

  // ── 1. Verify Railway CLI ──
  const hasCli = await isRailwayCliInstalled();
  if (!hasCli) {
    console.error(chalk.red("✖ Railway CLI not found"));
    console.log(chalk.gray("Install it with:"));
    console.log(chalk.cyan("  npm install -g @railway/cli"));
    console.log(chalk.gray("Or visit: https://docs.railway.app/develop/cli\n"));
    process.exit(1);
  }

  // ── 2. Verify project is linked ──
  const isLinked = await isRailwayProjectLinked(projectRoot);
  if (!isLinked) {
    console.log(chalk.yellow("⚠️  No Railway project linked."));
    console.log(chalk.gray("Run the following to link or create a project:"));
    console.log(chalk.cyan("  railway login"));
    console.log(chalk.cyan("  railway init\n"));
    process.exit(1);
  }

  // ── 3. Optional: create railway.json if not present ──
  const railwayJsonPath = join(projectRoot, "railway.json");
  if (!existsSync(railwayJsonPath)) {
    const spinner = ora("Creating railway.json...").start();
    const config = {
      $schema: "https://railway.app/railway.schema.json",
      build: {
        builder: "DOCKERFILE",
        dockerfilePath: "docker/Dockerfile.prod",
      },
      deploy: {
        startCommand: "sh /app/docker/start-with-check.sh",
        healthcheckPath: "/api/health",
        healthcheckTimeout: 300,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 3,
      },
    };
    await writeFile(railwayJsonPath, JSON.stringify(config, null, 2) + "\n");
    spinner.succeed(chalk.green("Created railway.json (Dockerfile build)"));
  }

  // ── 4. Build locally first ──
  const buildSpinner = ora("Building project...").start();
  try {
    await execa("pnpm", ["build"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    buildSpinner.succeed(chalk.green("Build successful"));
  } catch (err: any) {
    buildSpinner.fail(chalk.red(`Build failed: ${err.message}`));
    process.exit(1);
  }

  // ── 5. Sync critical env vars to Railway ──
  const envSpinner = ora("Syncing environment variables...").start();
  try {
    const envVars = await readEnvFile(projectRoot);
    const criticalVars = [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "REDIS_URL",
      "MINIO_ENDPOINT",
      "MINIO_ACCESS_KEY",
      "MINIO_SECRET_KEY",
      "S3_BUCKET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
    ];

    const varsToSync: string[] = [];
    for (const key of criticalVars) {
      if (envVars[key]) {
        varsToSync.push(`${key}=${envVars[key]}`);
      }
    }

    if (varsToSync.length > 0) {
      // Set variables in batches to avoid command line length issues
      const batchSize = 5;
      for (let i = 0; i < varsToSync.length; i += batchSize) {
        const batch = varsToSync.slice(i, i + batchSize);
        await execa("railway", ["variables", "set", ...batch], { cwd: projectRoot });
      }
    }
    envSpinner.succeed(chalk.green(`Synced ${varsToSync.length} environment variables`));
  } catch (err: any) {
    envSpinner.warn(chalk.yellow(`Could not sync env vars: ${err.message}`));
  }

  // ── 6. Deploy ──
  const deploySpinner = ora("Deploying to Railway...").start();
  try {
    const args = ["up"];
    if (options.preview) args.push("--environment", "preview");
    if (options.region) args.push("--region", options.region);

    await execa("railway", args, {
      cwd: projectRoot,
      stdio: "pipe",
    });

    deploySpinner.succeed(chalk.green("Deployed to Railway!"));

    // ── 7. Get deployment URL ──
    try {
      const domainResult = await execa("railway", ["domain"], { cwd: projectRoot });
      const domain = domainResult.stdout.trim();
      if (domain) {
        const url = `https://${domain}`;
        console.log(chalk.bold("\n🌐 Deployment URL:\n"));
        console.log(chalk.cyan(`  ${url}\n`));

        // ── 8. Health check ──
        const healthSpinner = ora("Running health check...").start();
        try {
          const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(30000) });
          if (health.ok) {
            const body = (await health.json()) as { status?: string };
            healthSpinner.succeed(chalk.green(`Health check passed ✅ (${body.status || "ok"})`));
          } else {
            healthSpinner.warn(chalk.yellow(`Health check returned ${health.status}`));
          }
        } catch {
          healthSpinner.warn(chalk.yellow("Health check timed out (app may still be starting)"));
        }

        console.log(chalk.gray("\nTip: Run 'kitsuden status' to check deployment status.\n"));
        return { success: true, url };
      }
    } catch {
      // domain command may fail if not supported
    }

    console.log(chalk.bold("\n🌐 Deployment complete!\n"));
    console.log(chalk.gray("Run 'railway domain' to get your deployment URL.\n"));
    return { success: true, url: null };
  } catch (err: any) {
    deploySpinner.fail(chalk.red(`Deployment failed: ${err.message}`));
    if (err.stderr) console.error(chalk.gray(err.stderr));
    return { success: false };
  }
}
