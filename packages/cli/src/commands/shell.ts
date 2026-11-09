import { createInterface } from "readline";

import chalk from "chalk";

import { loadDatabase, closeDatabase } from "../utils/database.js";
import { loadKons } from "../utils/kons.js";

export async function shellCommand(_options: { typescript?: boolean }) {
  console.log(chalk.blue("🐚 Kitsuden Interactive Shell\n"));
  console.log(chalk.gray("Type .help for commands, .exit to quit\n"));

  try {
    const { db, client } = await loadDatabase();
    const kons = await loadKons();

    // Context available in the shell
    const context = {
      db,
      ...kons.models,
      sql: (strings: TemplateStringsArray, ...values: any[]) => {
        return db.execute(sql(strings, ...values));
      },
    };

    console.log(chalk.green("Available:"));
    console.log(chalk.gray("  db          - Database connection"));
    Object.keys(kons.models).forEach((model) => {
      console.log(chalk.gray(`  ${model.padEnd(12)} - Model`));
    });
    console.log();

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan("kitsuden> "),
    });

    rl.prompt();

    rl.on("line", async (line: string) => {
      const input = line.trim();

      if (input === ".exit" || input === ".quit") {
        console.log(chalk.gray("\nGoodbye! 👋"));
        await closeDatabase(client);
        rl.close();
        return;
      }

      if (input === ".help") {
        showHelp();
        rl.prompt();
        return;
      }

      if (input === ".models") {
        console.log(chalk.yellow("Available models:"));
        Object.keys(kons.models).forEach((model) => {
          console.log(chalk.gray(`  - ${model}`));
        });
        rl.prompt();
        return;
      }

      if (input === ".tables") {
        const tables = (await db.execute(
          sql.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
        )) as any[];
        console.log(chalk.yellow("Database tables:"));
        tables.forEach((t: any) => console.log(chalk.gray(`  - ${t.tablename}`)));
        rl.prompt();
        return;
      }

      if (!input) {
        rl.prompt();
        return;
      }

      // Evaluate code
      try {
        const result = await evaluateAsync(input, context);
        console.log(result);
      } catch (error: any) {
        console.error(chalk.red("Error:"), error.message);
      }

      rl.prompt();
    });

    rl.on("close", () => {
      closeDatabase(client).then(() => process.exit(0));
    });
  } catch (error) {
    console.error(chalk.red("❌ Failed to start shell:"), error);
    process.exit(1);
  }
}

function showHelp() {
  console.log(chalk.yellow("Available commands:"));
  console.log(chalk.gray("  .help      Show this help"));
  console.log(chalk.gray("  .models    List available models"));
  console.log(chalk.gray("  .tables    List database tables"));
  console.log(chalk.gray("  .exit      Exit shell"));
  console.log();
  console.log(chalk.yellow("Examples:"));
  console.log(chalk.gray("  await db.query.users.findMany()"));
  console.log(chalk.gray("  await sql`SELECT COUNT(*) FROM users`"));
  console.log();
}

async function evaluateAsync(code: string, context: Record<string, any>): Promise<any> {
  // Create an async function with the context
  const keys = Object.keys(context);
  const values = Object.values(context);

  const fn = new Function(
    ...keys,
    `
    return (async () => {
      try {
        const result = await (${code});
        return result;
      } catch (e) {
        throw e;
      }
    })();
  `
  );

  return await fn(...values);
}

import { sql } from "drizzle-orm";
