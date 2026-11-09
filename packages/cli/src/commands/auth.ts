/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTH COMMAND — Zero-Config Social Auth Setup
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   kitsuden auth add google --client-id xxx --client-secret yyy
 *   kitsuden auth add github --client-id xxx --client-secret yyy
 *   kitsuden auth add microsoft --client-id xxx --client-secret yyy --tenant common
 *   kitsuden auth list
 *   kitsuden auth remove google
 */

import { execSync } from "child_process";
import path from "path";

import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";

const ENV_FILE = ".env";

interface AuthProvider {
  name: string;
  envPrefix: string;
  fields: { key: string; label: string; required: boolean }[];
}

const PROVIDERS: Record<string, AuthProvider> = {
  google: {
    name: "Google",
    envPrefix: "GOOGLE",
    fields: [
      { key: "CLIENT_ID", label: "Client ID", required: true },
      { key: "CLIENT_SECRET", label: "Client Secret", required: true },
    ],
  },
  github: {
    name: "GitHub",
    envPrefix: "GITHUB",
    fields: [
      { key: "CLIENT_ID", label: "Client ID", required: true },
      { key: "CLIENT_SECRET", label: "Client Secret", required: true },
    ],
  },
  microsoft: {
    name: "Microsoft / Azure AD",
    envPrefix: "AZURE_AD",
    fields: [
      { key: "CLIENT_ID", label: "Client ID", required: true },
      { key: "CLIENT_SECRET", label: "Client Secret", required: true },
      { key: "TENANT_ID", label: "Tenant ID", required: false },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// ADD PROVIDER
// ═══════════════════════════════════════════════════════════════════════════

export async function addProvider(providerId: string, options: Record<string, string | undefined>) {
  const spinner = ora();

  const provider = PROVIDERS[providerId.toLowerCase()];
  if (!provider) {
    console.error(chalk.red(`Unknown provider: ${providerId}`));
    console.log(chalk.yellow(`Supported providers: ${Object.keys(PROVIDERS).join(", ")}`));
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), ENV_FILE);
  if (!(await fs.pathExists(envPath))) {
    spinner.fail(chalk.red(`No ${ENV_FILE} found in current directory`));
    console.log(chalk.yellow('Run "kitsuden init" first or create a .env file'));
    process.exit(1);
  }

  spinner.start(`Configuring ${provider.name} authentication...`);

  // Read existing env
  let envContent = await fs.readFile(envPath, "utf-8");

  // Extract values from options or prompt
  const values: Record<string, string> = {};
  for (const field of provider.fields) {
    const optionKey = field.key.toLowerCase().replace(/_/g, "-");
    const value = options[optionKey] || options[field.key.toLowerCase()];

    if (value) {
      values[field.key] = value;
    } else if (field.required) {
      spinner.fail(chalk.red(`Missing required option: --${optionKey}`));
      console.log(chalk.yellow(`Usage: kitsuden auth add ${providerId} --${optionKey} <value>`));
      process.exit(1);
    }
  }

  // Update env file
  for (const [key, value] of Object.entries(values)) {
    const envKey = `${provider.envPrefix}_${key}`;
    const regex = new RegExp(`^${envKey}=.*$`, "m");
    const line = `${envKey}=${value}`;

    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, line);
    } else {
      envContent += `\n${line}`;
    }
  }

  await fs.writeFile(envPath, envContent.trim() + "\n");

  spinner.succeed(chalk.green(`${provider.name} authentication configured!`));

  // Instructions
  console.log(chalk.cyan("\n📋 Environment variables updated:"));
  for (const [key, value] of Object.entries(values)) {
    console.log(chalk.gray(`  ${provider.envPrefix}_${key}=${value}`));
  }

  // Auto-restart API if running in Docker
  await restartApiIfRunning();

  console.log(chalk.white(`\n🔑 Test: open http://localhost:3000/api/auth/signin`));
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════

export async function listProviders() {
  const envPath = path.resolve(process.cwd(), ENV_FILE);
  if (!(await fs.pathExists(envPath))) {
    console.log(chalk.yellow("No .env file found"));
    return;
  }

  const envContent = await fs.readFile(envPath, "utf-8");

  console.log(chalk.cyan("\n📋 Configured Auth Providers:\n"));

  let anyConfigured = false;
  for (const [_id, provider] of Object.entries(PROVIDERS)) {
    const clientIdKey = `${provider.envPrefix}_CLIENT_ID`;
    const hasClientId = new RegExp(`^${clientIdKey}=.+$`, "m").test(envContent);

    if (hasClientId) {
      anyConfigured = true;
      const status = chalk.green("● Active");
      console.log(`  ${provider.name.padEnd(20)} ${status}`);

      // Show which fields are set
      for (const field of provider.fields) {
        const envKey = `${provider.envPrefix}_${field.key}`;
        const match = envContent.match(new RegExp(`^${envKey}=(.+)$`, "m"));
        const masked = match ? `${match[1].slice(0, 4)}****${match[1].slice(-4)}` : "not set";
        console.log(chalk.gray(`    ${field.label}: ${masked}`));
      }
    } else {
      console.log(`  ${provider.name.padEnd(20)} ${chalk.gray("○ Not configured")}`);
    }
  }

  if (!anyConfigured) {
    console.log(chalk.yellow("  No providers configured yet."));
    console.log(
      chalk.white("  Run: kitsuden auth add <provider> --client-id <id> --client-secret <secret>")
    );
  }

  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// REMOVE PROVIDER
// ═══════════════════════════════════════════════════════════════════════════

export async function removeProvider(providerId: string) {
  const spinner = ora();

  const provider = PROVIDERS[providerId.toLowerCase()];
  if (!provider) {
    console.error(chalk.red(`Unknown provider: ${providerId}`));
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), ENV_FILE);
  if (!(await fs.pathExists(envPath))) {
    spinner.fail(chalk.red("No .env file found"));
    process.exit(1);
  }

  spinner.start(`Removing ${provider.name} authentication...`);

  let envContent = await fs.readFile(envPath, "utf-8");

  for (const field of provider.fields) {
    const envKey = `${provider.envPrefix}_${field.key}`;
    const regex = new RegExp(`^${envKey}=.*\n?`, "gm");
    envContent = envContent.replace(regex, "");
  }

  await fs.writeFile(envPath, envContent.trim() + "\n");

  spinner.succeed(chalk.green(`${provider.name} authentication removed`));

  // Auto-restart API if running in Docker
  await restartApiIfRunning();
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-RESTART HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function restartApiIfRunning(): Promise<void> {
  const projectRoot = process.cwd();

  // Check if docker-compose.yml exists
  const hasDockerCompose =
    fs.existsSync(path.join(projectRoot, "docker-compose.yml")) ||
    fs.existsSync(path.join(projectRoot, "docker-compose.yaml"));

  if (!hasDockerCompose) {
    console.log(chalk.yellow("\n🔄 Restart your API manually for changes to take effect:"));
    console.log(chalk.white("  cd apps/api && bun run dev"));
    return;
  }

  try {
    // Check if kitsuden_api container is running
    const output = execSync('docker compose ps --services --filter "status=running"', {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    if (!output.includes("kitsuden_api")) {
      console.log(chalk.yellow("\n🔄 API container not running. Start it with:"));
      console.log(chalk.white("  docker compose up -d"));
      return;
    }

    // Restart the API container
    const restartSpinner = ora("Restarting Kitsuden API...").start();
    execSync("docker compose restart kitsuden_api", {
      cwd: projectRoot,
      stdio: "pipe",
    });
    restartSpinner.succeed(chalk.green("API restarted successfully!"));
    console.log(chalk.gray("  Auth changes are now live."));
  } catch {
    console.log(chalk.yellow("\n🔄 Could not auto-restart API. Restart manually:"));
    console.log(chalk.white("  docker compose restart kitsuden_api"));
  }
}
