/**
 * DEPLOY Command - Deploy to production
 *
 * Railway is the only provider this command can deploy to. For a VPS, follow
 * docs/install/server.md (scripts/deploy.sh).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import chalk from "chalk";

import { deployToRailway } from "../deploy/railway.js";

export interface DeployOptions {
  preview?: boolean;
  prod?: boolean;
  region?: string;
  provider?: string;
  railway?: boolean;
  build?: boolean;
}

export async function deployCommand(options: DeployOptions) {
  const projectRoot = process.cwd();

  // Check if we're in a Kitsuden project
  if (
    !existsSync(join(projectRoot, "apps", "api")) &&
    !existsSync(join(projectRoot, "kitsuden.config.ts"))
  ) {
    console.error(chalk.red("✖ Not in a Kitsuden project directory"));
    process.exit(1);
  }

  const detectedProvider = detectProvider(projectRoot, options);

  if (detectedProvider !== "railway") {
    console.error(
      chalk.red(
        detectedProvider
          ? `✖ Unknown deployment provider: ${detectedProvider}. Available: railway.`
          : "✖ No deployment provider. Pass --railway (or add railway.json)."
      )
    );
    console.error(
      chalk.gray("For your own server, see docs/install/server.md (scripts/deploy.sh).")
    );
    process.exit(1);
  }

  const result = await deployToRailway(projectRoot, {
    preview: options.preview,
    prod: options.prod,
    region: options.region,
  });

  if (!result.success) {
    process.exit(1);
  }
}

function detectProvider(projectRoot: string, options: DeployOptions): string | null {
  // Explicit flag takes highest priority
  if (options.provider) {
    return options.provider;
  }
  if (options.railway) {
    return "railway";
  }

  // Auto-detect from project files
  if (existsSync(join(projectRoot, "railway.json"))) {
    return "railway";
  }

  return null;
}
