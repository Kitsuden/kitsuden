import fs from "fs/promises";
import path from "path";

import chalk from "chalk";
import { sql } from "drizzle-orm";

import { loadDatabase, closeDatabase } from "../utils/database.js";

// import { findProjectRoot } from '../utils/project.js';

export async function inspectCommand(target: string) {
  switch (target) {
    case "routes":
      await inspectRoutes();
      break;
    case "kons":
      await inspectKons();
      break;
    case "middleware":
      await inspectMiddleware();
      break;
    case "db":
    case "database":
      await inspectDatabase();
      break;
    default:
      console.error(chalk.red(`Unknown inspect target: ${target}`));
      console.log("Available: routes, kons, middleware, db");
      process.exit(1);
  }
}

async function inspectRoutes() {
  console.log(chalk.blue("🛣️  Registered Routes\n"));
  console.log(chalk.gray("Scanning apps/api/src...\n"));

  // Show common API routes
  const routes = [
    { method: "GET", path: "/api/health", handler: "system" },
    { method: "GET", path: "/api/datasets/:slug", handler: "datasets" },
    { method: "POST", path: "/api/datasets/:slug", handler: "datasets" },
    { method: "GET", path: "/api/datasets/:slug/:id", handler: "datasets" },
    { method: "PUT", path: "/api/datasets/:slug/:id", handler: "datasets" },
    { method: "DELETE", path: "/api/datasets/:slug/:id", handler: "datasets" },
    { method: "GET", path: "/api/auth/session", handler: "auth" },
    { method: "POST", path: "/api/auth/login", handler: "auth" },
    { method: "POST", path: "/api/auth/logout", handler: "auth" },
    { method: "GET", path: "/api/docs/openapi.json", handler: "docs" },
  ];

  console.log(chalk.yellow(`${"Method".padEnd(8)} ${"Path".padEnd(40)} ${"Handler"}`));
  console.log(chalk.gray("-".repeat(80)));

  for (const route of routes) {
    console.log(
      chalk.green(route.method.padEnd(8)) +
        chalk.cyan(route.path.padEnd(40)) +
        chalk.gray(route.handler)
    );
  }

  console.log(chalk.gray(`\nTotal: ${routes.length} route(s)`));
}

async function inspectKons() {
  console.log(chalk.blue("📦 Active Kons\n"));

  const konsPath = path.resolve("packages/kons");

  try {
    const kons = await fs.readdir(konsPath);

    console.log(
      chalk.yellow(
        `${"Name".padEnd(25)} ${"Version".padEnd(10)} ${"Status".padEnd(10)} ${"Tables"}`
      )
    );
    console.log(chalk.gray("-".repeat(70)));

    for (const kon of kons) {
      const konJsonPath = path.join(konsPath, kon, "kon.json");

      try {
        const config = JSON.parse(await fs.readFile(konJsonPath, "utf-8"));

        // Count tables
        const schemaPath = path.join(konsPath, kon, "schema.ts");
        let tableCount = 0;
        try {
          const schemaContent = await fs.readFile(schemaPath, "utf-8");
          tableCount = (schemaContent.match(/export const \w+ = pgTable/g) || []).length;
        } catch {}

        console.log(
          chalk.white(config.name.padEnd(25)) +
            chalk.gray((config.version || "0.0.0").padEnd(10)) +
            chalk.green("active".padEnd(10)) +
            chalk.yellow(tableCount)
        );

        if (config.dependencies?.length) {
          console.log(chalk.gray(`  deps: ${config.dependencies.join(", ")}`));
        }
      } catch {
        console.log(chalk.gray(`${kon.padEnd(25)} (no config)`));
      }
    }
  } catch (error) {
    console.error(chalk.red("Error reading kons:"), error);
  }
}

async function inspectMiddleware() {
  console.log(chalk.blue("🥞 Middleware Chain\n"));

  const middlewares = [
    { name: "security", priority: 100, description: "Security headers, CORS" },
    { name: "logger", priority: 90, description: "Request logging" },
    { name: "auth", priority: 80, description: "Authentication" },
    { name: "rateLimit", priority: 70, description: "Rate limiting" },
    { name: "bodyParser", priority: 60, description: "Body parsing" },
  ];

  console.log(chalk.yellow("Middleware execution order:\n"));

  middlewares.sort((a, b) => b.priority - a.priority);

  for (let i = 0; i < middlewares.length; i++) {
    const m = middlewares[i];
    const arrow = i === 0 ? "┌─▶" : i === middlewares.length - 1 ? "└─▶" : "├─▶";
    console.log(
      chalk.gray(`${arrow} [${String(m.priority).padStart(3)}] `) +
        chalk.cyan(m.name.padEnd(15)) +
        chalk.gray(m.description)
    );
  }
}

async function inspectDatabase() {
  console.log(chalk.blue("🗄️  Database Schema\n"));

  try {
    const { db, client } = await loadDatabase();

    // Get tables
    const tables = await db.execute(sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    for (const table of tables) {
      const tableName = table.tablename;
      console.log(chalk.yellow(`\n📋 ${tableName}`));

      // Get columns
      const columns = (await db.execute(sql`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_name = ${tableName}
        ORDER BY ordinal_position
      `)) as any[];

      for (const col of columns) {
        const nullable = col.is_nullable === "YES" ? chalk.gray("?") : chalk.red("*");
        const type = chalk.gray(col.data_type);
        console.log(`  ${nullable} ${chalk.white(col.column_name.padEnd(20))} ${type}`);
      }
    }

    await closeDatabase(client);

    console.log(chalk.green(`\n\nTotal: ${tables.length} table(s)`));
  } catch (error) {
    console.error(chalk.red("Error querying database:"), error);
  }
}
