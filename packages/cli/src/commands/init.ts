/**
 * `kitsuden init <name>`: scaffold a project folder.
 *
 *   developer (default)  a compose file with the infrastructure (Postgres, and
 *                        Valkey as an opt-in profile), .env with generated secrets
 *                        and the config. The API runs from a Kitsuden checkout.
 *   lite                 .env for the embedded database (PGlite), no Docker.
 *                        Experimental: the migrations need pgvector, which PGlite
 *                        does not have, so the core schema does not apply yet.
 *
 * Nothing here pulls a Kitsuden image or names a package that is not published:
 * see docs/install/ for running the API itself. `kitsuden new` creates a website.
 */

import { spawnSync } from "child_process";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import ora, { type Ora } from "ora";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve package root (dist/commands/ -> dist/ -> package root)
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

const REPOSITORY_URL = "https://github.com/Kitsuden/kitsuden";

// Same images as docker-compose.dev.yml and docker-compose.test.yml.
const POSTGRES_IMAGE =
  "pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337";
const VALKEY_IMAGE =
  "valkey/valkey:7.2.15-alpine@sha256:f8c1a646f4b31ae4dc3980ff06723a20b533ea1123b9796d450d78ed53ad6d3e";

function getTemplatePath(templateName: string): string {
  return path.join(PACKAGE_ROOT, "templates", templateName);
}

/**
 * Generate a cryptographically secure random secret string.
 * Hex, so that it can go in a connection URL as it is.
 */
function generateSecret(length = 32): string {
  return crypto.randomBytes(length).toString("hex");
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

interface TemplateConfig {
  name: string;
  description: string;
  kons: string[];
}

const TEMPLATES: Record<string, TemplateConfig> = {
  default: {
    name: "Default",
    description: "Core functionality: auth, datasets, media",
    kons: ["kon-auth", "kon-datasets", "kon-media"],
  },
  blog: {
    name: "Blog",
    description: "Content-focused blog with posts, tags, and SEO",
    kons: ["kon-auth", "kon-datasets", "kon-media", "kon-blog"],
  },
  saas: {
    name: "SaaS",
    description: "Teams, subscriptions, and user management",
    kons: ["kon-auth", "kon-datasets", "kon-media"],
  },
  ecommerce: {
    name: "E-Commerce",
    description: "Online store with products, orders, inventory",
    kons: ["kon-auth", "kon-datasets", "kon-media"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface InitOptions {
  template?: string;
  mode?: "developer" | "lite";
  database?: string;
  /** Embedded PostgreSQL (PGlite), no Docker. */
  lite?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN INIT COMMAND
// ═══════════════════════════════════════════════════════════════════════════

export async function initCommand(name: string | undefined, options: InitOptions) {
  const spinner = ora();

  try {
    const mode = options.lite ? "lite" : options.mode || "developer";
    if (mode !== "developer" && mode !== "lite") {
      spinner.fail(chalk.red(`Unknown mode "${String(mode)}". Available: developer, lite.`));
      process.exit(1);
    }

    // ── Ask for project name if not provided ──
    let projectName = name;
    if (!projectName) {
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Project name:",
          default: "my-kitsuden-app",
        },
      ]);
      projectName = answers.name;
    }

    const projectPath = path.resolve(process.cwd(), projectName || "my-kitsuden-app");

    // ── Check if directory exists ──
    if (await fs.pathExists(projectPath)) {
      spinner.fail(chalk.red(`Directory "${projectName}" already exists`));
      process.exit(1);
    }

    // ── Determine template ──
    let template = options.template || "default";
    if (!TEMPLATES[template]) {
      spinner.warn(chalk.yellow(`Unknown template "${template}". Using default.`));
      template = "default";
    }

    const templateConfig = TEMPLATES[template];

    console.log(chalk.cyan(`\n🚀 Kitsuden: ${mode} project\n`));
    console.log(chalk.gray(`Template: ${templateConfig.name} — ${templateConfig.description}\n`));

    spinner.start("Creating project...");
    await fs.ensureDir(projectPath);

    if (mode === "lite") {
      await createLiteProject(projectPath, projectName || "my-kitsuden-app", spinner);
    } else {
      await createDeveloperProject(
        projectPath,
        projectName || "my-kitsuden-app",
        template,
        templateConfig,
        spinner
      );
    }

    spinner.succeed(chalk.green(`✅ Project "${projectName}" created`));

    if (mode === "lite") {
      printLiteOutput(projectName || "my-kitsuden-app");
    } else {
      printDeveloperOutput(projectName || "my-kitsuden-app");
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to initialize project"));
    console.error(error);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LITE MODE: no infrastructure
//
// The database is PGlite (PostgreSQL embedded in WASM), so the schema, the
// migrations and the RLS policies are the same as in production.
// ═══════════════════════════════════════════════════════════════════════════

async function createLiteProject(projectPath: string, projectName: string, spinner: Ora) {
  spinner.text = "Generating lite project (no Docker)...";

  await fs.ensureDir(path.join(projectPath, ".kitsuden"));
  await fs.ensureDir(path.join(projectPath, "uploads"));

  await fs.writeFile(path.join(projectPath, ".env"), generateLiteEnv(projectName), { mode: 0o600 });

  await fs.writeFile(
    path.join(projectPath, ".gitignore"),
    ["node_modules/", ".env", ".kitsuden/", "uploads/", "dist/", "*.log"].join("\n") + "\n"
  );

  await fs.writeFile(
    path.join(projectPath, "README.md"),
    `# ${projectName}

Kitsuden settings in **lite mode**: no Docker, no database to install.

The database is **embedded PostgreSQL** (PGlite) and lives in \`.kitsuden/data\`.

**Experimental.** The migration chain needs the \`vector\` extension, which PGlite
does not have, so \`scripts/migrate.ts\` stops and the API starts without the core
tables. For a working install, use \`kitsuden init --mode developer\` or
\`docs/install/\` in the Kitsuden repository.

## Run the API

The API runs from a checkout of [Kitsuden](${REPOSITORY_URL}) (Node 22.12+, Bun
1.3+ and pnpm 9):

\`\`\`bash
git clone ${REPOSITORY_URL}.git
cd kitsuden
pnpm install --frozen-lockfile
cp /path/to/${projectName}/.env apps/api/.env
pnpm dev:api          # API on http://localhost:3001
\`\`\`

## Moving to production

Change one line in \`.env\`:

\`\`\`bash
DATABASE_URL=postgres://user:pass@host:5432/db
KITSUDEN_LITE=false
\`\`\`
`
  );
}

function printLiteOutput(projectName: string) {
  console.log(chalk.cyan("\n⚡ Lite mode: embedded Postgres, no Docker\n"));
  console.log(
    chalk.yellow("  Experimental: the migrations need pgvector, which PGlite lacks, so the core")
  );
  console.log(
    chalk.yellow(
      "  schema does not apply yet. For a working install: kitsuden init --mode developer\n"
    )
  );
  console.log(
    chalk.white(`  See ${projectName}/README.md to run the API from a Kitsuden checkout.\n`)
  );
  console.log(chalk.gray("  API:      http://localhost:3001"));
  console.log(chalk.gray("  DB:       embedded PostgreSQL in .kitsuden/data\n"));
}

// ═══════════════════════════════════════════════════════════════════════════
// DEVELOPER MODE: infrastructure in Docker, the API from a checkout
// ═══════════════════════════════════════════════════════════════════════════

async function createDeveloperProject(
  projectPath: string,
  projectName: string,
  template: string,
  templateConfig: TemplateConfig,
  spinner: Ora
) {
  spinner.text = "Creating project structure...";

  await fs.ensureDir(path.join(projectPath, "docker"));

  // Template files, as a starting point (the seed goes in by hand, after migrating)
  const templateDir = getTemplatePath(template);
  if (await fs.pathExists(templateDir)) {
    for (const file of ["grimoire.json", "seed.sql"]) {
      const src = path.join(templateDir, file);
      if (await fs.pathExists(src)) await fs.copy(src, path.join(projectPath, file));
    }
  }
  const grimoirePath = path.join(projectPath, "grimoire.json");
  if (!(await fs.pathExists(grimoirePath))) {
    await fs.writeFile(
      grimoirePath,
      JSON.stringify(
        {
          name: templateConfig.name,
          template,
          kons: templateConfig.kons,
          mode: "developer",
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
  }

  await fs.writeFile(
    path.join(projectPath, "docker-compose.yml"),
    generateDeveloperDockerCompose()
  );
  await fs.writeFile(
    path.join(projectPath, "docker", "init-app-role.sh"),
    generateAppRoleScript(),
    {
      mode: 0o755,
    }
  );

  // Environment files: the example has placeholders, .env has generated secrets
  await fs.writeFile(path.join(projectPath, ".env.example"), generateDeveloperEnvExampleFile());
  await fs.writeFile(path.join(projectPath, ".env"), generateDeveloperEnvFile(), { mode: 0o600 });

  await fs.writeFile(
    path.join(projectPath, "kitsuden.config.ts"),
    generateDeveloperConfigFile(templateConfig.kons)
  );
  await fs.writeFile(path.join(projectPath, "README.md"), generateDeveloperReadme(projectName));
  await fs.writeFile(
    path.join(projectPath, ".gitignore"),
    "node_modules\n.env\n.env.local\ndata/\ndist/\n*.log\n.DS_Store\n"
  );
  await fs.writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify(generateDeveloperPackageJson(projectName), null, 2) + "\n"
  );

  // Git init. Fixed arguments and no shell; git may simply not be installed.
  for (const args of [
    ["init"],
    ["add", "."],
    ["commit", "-m", "Initial commit from Kitsuden CLI"],
  ]) {
    if (spawnSync("git", args, { cwd: projectPath, stdio: "ignore", shell: false }).status !== 0)
      break;
  }
}

function printDeveloperOutput(projectName: string) {
  console.log(chalk.cyan("\n📁 Project structure:"));
  console.log(`  ${projectName}/`);
  console.log("  ├── docker-compose.yml    # Postgres (Valkey with --profile replicas)");
  console.log("  ├── docker/               # Creates the API's database role");
  console.log("  ├── .env                  # Generated secrets");
  console.log("  ├── kitsuden.config.ts    # Backend configuration");
  console.log("  └── README.md             # How to run the API against it");

  console.log(chalk.cyan("\n🛠️ Next steps:"));
  console.log(chalk.white(`  cd ${projectName}`));
  console.log(chalk.white("  docker compose up -d"));
  console.log(chalk.white("  Then follow README.md to run the API from a Kitsuden checkout.\n"));
}

/**
 * .env for lite mode. DATABASE_URL=lite turns on PGlite; without Valkey the cache
 * is in memory, and without S3 storage is the local disk.
 */
function generateLiteEnv(projectName: string): string {
  return `# Kitsuden: lite mode (no Docker)
# Generated by the Kitsuden CLI. Rotate the secrets before production use.
PROJECT_NAME=${projectName}

# EMBEDDED PostgreSQL (PGlite). For production, use your real Postgres:
#   DATABASE_URL=postgres://user:pass@host:5432/db
DATABASE_URL=lite
KITSUDEN_LITE=true
KITSUDEN_LITE_DIR=.kitsuden/data

API_PORT=3001
BETTER_AUTH_SECRET=${generateSecret(32)}
# The vault's own key: production refuses to start without it.
KITSUDEN_SECRETS_KEY=${generateSecret(32)}
BETTER_AUTH_URL=http://localhost:3001

NODE_ENV=development
LOG_LEVEL=info
`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

function generateDeveloperDockerCompose(): string {
  return `# Kitsuden: development infrastructure
# Generated by the Kitsuden CLI. The API runs from a Kitsuden checkout: see README.md.
#
# Every port is on 127.0.0.1, so nothing here is reachable from another machine.
# Docker bypasses ufw for published ports: the address is what protects them.
#
#   docker compose up -d                      # Postgres
#   docker compose --profile replicas up -d   # + Valkey, for several API replicas

services:
  postgres:
    image: ${POSTGRES_IMAGE}
    container_name: kitsuden_postgres_dev
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-kitsuden}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required - set it in .env}
      POSTGRES_DB: \${POSTGRES_DB:-kitsuden}
      APP_DB_USER: \${APP_DB_USER:-kitsuden_app}
      APP_DB_PASSWORD: \${APP_DB_PASSWORD:?APP_DB_PASSWORD is required - set it in .env}
    ports:
      - "127.0.0.1:\${DB_PORT:-5432}:5432"
    volumes:
      - kitsuden_postgres_dev:/var/lib/postgresql/data
      - ./docker/init-app-role.sh:/docker-entrypoint-initdb.d/10-init-app-role.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-kitsuden} -d \${POSTGRES_DB:-kitsuden}"]
      interval: 5s
      timeout: 5s
      retries: 10

  valkey:
    image: ${VALKEY_IMAGE}
    profiles: ["replicas"]
    container_name: kitsuden_valkey_dev
    restart: unless-stopped
    command: valkey-server --requirepass \${VALKEY_PASSWORD:?VALKEY_PASSWORD is required - set it in .env} --maxmemory 256mb --maxmemory-policy noeviction --appendonly yes
    environment:
      REDISCLI_AUTH: \${VALKEY_PASSWORD:?VALKEY_PASSWORD is required - set it in .env}
    ports:
      - "127.0.0.1:\${CACHE_PORT:-6379}:6379"
    volumes:
      - kitsuden_valkey_dev:/data
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  kitsuden_postgres_dev:
  kitsuden_valkey_dev:
`;
}

/**
 * Runs once, when Postgres initializes an empty volume.
 *
 * The API must not connect as the superuser POSTGRES_USER: Postgres ignores RLS
 * policies for superusers, so row isolation would silently do nothing.
 */
function generateAppRoleScript(): string {
  return `#!/bin/sh
# Creates the role the API connects with. See DATABASE_URL in .env.
set -eu

psql -v ON_ERROR_STOP=1 \\
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \\
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" -v db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
SQL
`;
}

function developerEnv(secrets: {
  postgresPassword: string;
  appDbPassword: string;
  valkeyPassword: string;
  betterAuthSecret: string;
  secretsKey: string;
}): string {
  return `# The API connects with the app role (RLS applies to it). The superuser is
# only for migrations: DATABASE_ADMIN_URL.
POSTGRES_USER=kitsuden
POSTGRES_PASSWORD=${secrets.postgresPassword}
POSTGRES_DB=kitsuden
APP_DB_USER=kitsuden_app
APP_DB_PASSWORD=${secrets.appDbPassword}
DATABASE_URL=postgres://kitsuden_app:${secrets.appDbPassword}@127.0.0.1:5432/kitsuden
DATABASE_ADMIN_URL=postgres://kitsuden:${secrets.postgresPassword}@127.0.0.1:5432/kitsuden

# Optional: only with --profile replicas.
VALKEY_PASSWORD=${secrets.valkeyPassword}
# REDIS_URL=redis://:${secrets.valkeyPassword}@127.0.0.1:6379

API_PORT=3000
PORT=3000
NODE_ENV=development

BETTER_AUTH_SECRET=${secrets.betterAuthSecret}
# The vault's own key: production refuses to start without it.
KITSUDEN_SECRETS_KEY=${secrets.secretsKey}
BETTER_AUTH_URL=http://localhost:3000

ADMIN_URL=http://localhost:5173
PUBLIC_API_URL=http://localhost:3000
PUBLIC_SITE_NAME=Kitsuden

DEFAULT_STORAGE_PROVIDER=local

ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
RATE_LIMIT_ENABLED=true
LOG_LEVEL=info
ENABLE_MCP=true

# Auth providers (managed with: kitsuden auth add <provider>)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# AZURE_AD_CLIENT_ID=
# AZURE_AD_CLIENT_SECRET=
# AZURE_AD_TENANT_ID=common
`;
}

function generateDeveloperEnvExampleFile(): string {
  return `# Kitsuden: development environment
# Copy to .env and replace every <placeholder>: openssl rand -hex 32
${developerEnv({
  postgresPassword: "<postgres-password>",
  appDbPassword: "<app-role-password>",
  valkeyPassword: "<valkey-password>",
  betterAuthSecret: "<at-least-32-characters>",
  secretsKey: "<openssl-rand-hex-32>",
})}`;
}

function generateDeveloperEnvFile(): string {
  return `# Kitsuden: development environment
# Generated by the Kitsuden CLI. Rotate the secrets before production use.
${developerEnv({
  postgresPassword: generateSecret(16),
  appDbPassword: generateSecret(16),
  valkeyPassword: generateSecret(16),
  betterAuthSecret: generateSecret(32),
  secretsKey: generateSecret(32),
})}`;
}

function generateDeveloperConfigFile(kons: string[]): string {
  return `// Kitsuden configuration

export default {
  name: 'My Kitsuden App',

  kons: [
${kons.map((g) => `    '${g}',`).join("\n")}
  ],

  auth: {
    providers: ['email', 'github', 'google'],
    sessionDuration: '7d',
    requireEmailVerification: true
  },

  api: {
    rateLimit: {
      enabled: true,
      requests: 100,
      window: '15m'
    },
    cors: {
      origins: ['http://localhost:3000', 'http://localhost:5173'],
      credentials: true
    }
  },

  mcp: {
    enabled: true,
    allowedOperations: ['read', 'write', 'admin']
  }
};
`;
}

function generateDeveloperReadme(projectName: string): string {
  return `# ${projectName}

Infrastructure and settings for a [Kitsuden](${REPOSITORY_URL}) backend.

## Quick start

\`\`\`bash
# 1. Start Postgres (127.0.0.1 only)
docker compose up -d

# 2. Get Kitsuden (needs Node 22.12+, Bun 1.3+ and pnpm 9)
git clone ${REPOSITORY_URL}.git
cd kitsuden
pnpm install --frozen-lockfile

# 3. Point the API at this project's settings
cp /path/to/${projectName}/.env apps/api/.env

# 4. Migrate as the superuser, then run the API as the app role
cd apps/api
DATABASE_URL="$(grep '^DATABASE_ADMIN_URL=' .env | cut -d= -f2-)" bun run scripts/migrate.ts
bun run dev
\`\`\`

More: \`docs/install/local.md\` in the Kitsuden repository.

## Files

- \`docker-compose.yml\`: Postgres, and Valkey with \`--profile replicas\`
- \`docker/init-app-role.sh\`: creates the API's database role when the volume is new
- \`.env\`: generated secrets. Do not commit it
- \`grimoire.json\`, \`seed.sql\`: the template's modules and sample data
`;
}

function generateDeveloperPackageJson(projectName: string): object {
  return {
    name: projectName.toLowerCase().replace(/\s+/g, "-"),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      up: "docker compose up -d",
      down: "docker compose down",
      logs: "docker compose logs -f",
    },
  };
}
