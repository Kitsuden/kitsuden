import path from "path";

import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";

/**
 * `kitsuden gen types` — TypeScript types from the schema
 * ============================================================================
 *
 * The equivalent of `supabase gen types typescript`, and the piece that separates
 * "I have an SDK" from "writing the frontend is pleasant": the difference between
 * autocomplete on every query and `Record<string, any>` on all of them.
 *
 * It reads the schema over HTTP instead of connecting to the database on purpose:
 * that way it works against a remote deployment, does not require Postgres credentials
 * on the machine of whoever runs it, and respects the API's permissions.
 */

export interface GenTypesOptions {
  url?: string;
  out?: string;
  exclude?: string;
  databaseName?: string;
}

export async function genTypesCommand(options: GenTypesOptions = {}) {
  const baseUrl = (options.url ?? process.env.KITSUDEN_API_URL ?? "http://localhost:3001").replace(
    /\/$/,
    ""
  );
  const outFile = options.out ?? "src/kitsuden.types.ts";

  const spinner = ora(`Reading schema from ${baseUrl}…`).start();

  try {
    const listRes = await fetch(`${baseUrl}/api/schema/tables`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });

    if (!listRes.ok) {
      spinner.fail(chalk.red(`Could not read the schema: HTTP ${listRes.status}`));
      if (listRes.status === 401 || listRes.status === 403) {
        console.log(
          chalk.gray("   Introspection requires a session. Run `kitsuden auth` or pass --url.")
        );
      }
      process.exit(1);
    }

    const payload = (await listRes.json()) as { tables?: unknown };
    const names = normalizeTableNames(payload.tables);

    if (names.length === 0) {
      spinner.warn(chalk.yellow("The schema has no tables. Are migrations missing?"));
      process.exit(1);
    }

    spinner.text = `Introspeccionando ${names.length} tables…`;

    // In series and not in parallel: there are dozens of tables and a simultaneous burst
    // against a small deployment is how the generator takes down the API
    // it is trying to describe.
    const tables = [];
    for (const name of names) {
      const res = await fetch(`${baseUrl}/api/schema/tables/${encodeURIComponent(name)}`, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { table?: unknown };
      if (body.table) tables.push(body.table);
    }

    if (tables.length === 0) {
      spinner.fail(chalk.red("No table could be introspected."));
      process.exit(1);
    }

    const { generateTypes } = await import("@kitsuden/codegen/generators/types");

    const code = generateTypes(tables as never, {
      exclude: options.exclude
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      databaseTypeName: options.databaseName,
    });

    const target = path.resolve(process.cwd(), outFile);
    await fs.ensureDir(path.dirname(target));

    // If the content does not change, the file is not touched: that way regenerating after every
    // migration does not dirty the git tree or trigger recompilations.
    const previous = (await fs.pathExists(target)) ? await fs.readFile(target, "utf-8") : null;
    if (previous === code) {
      spinner.succeed(chalk.green(`No schema changes — ${outFile} is already up to date`));
      return;
    }

    await fs.writeFile(target, code, "utf-8");
    spinner.succeed(chalk.green(`Types generated for ${tables.length} tables → ${outFile}`));

    console.log();
    console.log(chalk.gray("   Use it like this:"));
    console.log(
      chalk.gray(`     import type { Database, Row } from "./${path.basename(outFile, ".ts")}";`)
    );
    console.log(
      chalk.gray(`     const client = createClient<Database>({ baseUrl: "${baseUrl}" });`)
    );
    console.log();
    console.log(chalk.gray("   Regenerate after every migration."));
  } catch (err) {
    spinner.fail(chalk.red("Type generation failed"));
    console.error(chalk.gray(`   ${err instanceof Error ? err.message : String(err)}`));
    if (err instanceof Error && /fetch failed|ECONNREFUSED/i.test(err.message)) {
      console.log(chalk.gray(`   Is the server up at ${baseUrl}?`));
    }
    process.exit(1);
  }
}

/**
 * The tables route can return strings or cards.
 * It is normalized here so that a change of shape in the API does not break the command
 * with an indecipherable error.
 */
function normalizeTableNames(tables: unknown): string[] {
  if (!Array.isArray(tables)) return [];
  return tables
    .map((t) => (typeof t === "string" ? t : ((t as { name?: string })?.name ?? null)))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}
