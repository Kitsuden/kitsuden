/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SYNC-SCHEMA — Regenerates the kon schemas aggregate
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   kitsuden sync-schema
 *
 * Scans the `schema` block of each kon.json and regenerates
 * apps/api/src/db/schema-kons.generated.ts (the aggregate consumed by
 * drizzle-kit). It replaces the MANUAL editing of schema-all.ts.
 *
 * Strategies per kon (kon.json → "schema"):
 *   - "drizzle": tables managed by drizzle-kit → go into the aggregate.
 *   - "sql":     the kon self-migrates with its own SQL → EXCLUDED (types only).
 *   - "authoritative": true → its symbols win over schema-core on collision.
 */

import { exec } from "child_process";
import path from "path";
import { promisify } from "util";

import chalk from "chalk";

import { findProjectRoot } from "../utils/project.js";

const execAsync = promisify(exec);

export async function syncSchemaCommand(): Promise<void> {
  try {
    const projectRoot = await findProjectRoot();
    const script = path.join(projectRoot, "apps", "api", "scripts", "sync-kon-schema.ts");

    console.log(chalk.blue("🔄 Regenerating kon schemas aggregate...\n"));

    const { stdout, stderr } = await execAsync(`bun run "${script}"`, {
      cwd: projectRoot,
      env: process.env,
    });

    // The script prints the summary (file + kons + collisions).
    const noise = /Config|Kons directory/;
    for (const line of `${stdout}${stderr}`.split("\n")) {
      if (line.trim() && !noise.test(line)) console.log(line);
    }

    console.log(chalk.gray("\nSiguiente: kitsuden makemigrations && kitsuden migrate"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("❌ sync-schema failed:"), msg);
    process.exit(1);
  }
}
