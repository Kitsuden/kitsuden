/**
 * kitsuden make model <name> · kitsuden makemigrations (defineModel)
 * ============================================================================
 *
 *   kitsuden make model note --kon notes    → packages/kons/kon-notes/src/note.model.ts
 *   kitsuden make model note --dir apps/api/src/models
 *
 *   kitsuden makemigrations                 → for each kon with models (`*.model.ts`
 *                                             or `models.ts`), compares with
 *                                             migrations/models.snapshot.json and
 *                                             writes migrations/NNNN_<name>.sql
 *   kitsuden makemigrations --kon notes     → only that kon
 *   kitsuden makemigrations --dir <folder>  → any folder (the app, a fixture)
 *   --dry-run                               → shows the SQL, does not write
 *   --allow-destructive                     → emits the DROPs (commented out by default)
 *
 * ── IT NEVER RUNS ANYTHING AGAINST A DATABASE ──────────────────────────────
 *
 * It generates text. The usual migration runner applies it, with the DDL
 * connection, when someone decides to. It does not read `DATABASE_URL`.
 *
 * ── WHY BUN ────────────────────────────────────────────────────────────────
 *
 * The models are TypeScript that imports `@kitsuden/shared`. The CLI runs on
 * compiled Node; to load them without a build step, `bun` is launched with a
 * one-off script INSIDE the model's folder (so `@kitsuden/shared`
 * resolves the same way the model itself resolves it) and it is deleted when done.
 * The diff is `generateModelMigration` from @kitsuden/shared: the same code
 * the tests exercise, not a copy.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import chalk from "chalk";

import { buildInvocation } from "../utils/run-command.js";

import { findEnclosingKon, findKonsRoot, konsDirOf } from "./make-kon.js";

// ── What is read from the model (shape from @kitsuden/shared, without importing it) ───

interface Snapshot {
  version: number;
  models: Record<string, unknown>;
}

interface RunnerResult {
  sql: string;
  snapshot: Snapshot;
  changes: string[];
  warnings: string[];
  header: string;
  models: string[];
}

export interface ModelsTarget {
  /** Folder with the models (a kon, the app, a fixture). */
  dir: string;
  /** Short name of the kon for RLS (`notes`), or `app`. */
  kon: string;
  /** Model files found. */
  files: string[];
  migrations: string;
}

export interface MakemigrationsResult {
  target: ModelsTarget;
  models: string[];
  changes: string[];
  warnings: string[];
  /** File written (or the one that would be written with --dry-run); null if there are no changes. */
  file: string | null;
  sql: string;
}

export interface MakemigrationsOptions {
  kon?: string;
  dir?: string;
  name?: string;
  dryRun?: boolean;
  allowDestructive?: boolean;
  root?: string;
  /** bun executable (tests). */
  bun?: string;
}

const SNAPSHOT = "models.snapshot.json";
const MODEL_FILE = /(\.model\.ts|^models\.ts)$/;
const IGNORE = new Set(["node_modules", "dist", "migrations", ".git", "build"]);

/**
 * `*.model.ts` and `models.ts` under `dir` (excluding node_modules, dist, migrations).
 */
export function modelFiles(dir: string): string[] {
  const output: string[] = [];
  const traverse = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const name of readdirSync(d)) {
      if (IGNORE.has(name) || name.startsWith("__")) continue;
      const route = join(d, name);
      const st = statSync(route);
      if (st.isDirectory()) traverse(route, depth + 1);
      else if (MODEL_FILE.test(name)) output.push(route);
    }
  };
  if (existsSync(dir)) traverse(dir, 0);
  return output.sort();
}

function shortKonOf(dir: string): string {
  const manifest = join(dir, "kon.json");
  if (existsSync(manifest)) {
    const id = (JSON.parse(readFileSync(manifest, "utf8")) as { id?: string }).id;
    if (id) return id.replace(/^kon-/, "");
  }
  return "app";
}

export function modelsTargets(o: MakemigrationsOptions): ModelsTarget[] {
  if (o.dir) {
    const dir = resolve(o.dir);
    if (!existsSync(dir)) throw new Error(`${o.dir} does not exist`);
    return [
      { dir, kon: shortKonOf(dir), files: modelFiles(dir), migrations: join(dir, "migrations") },
    ];
  }
  const root = o.root ? resolve(o.root) : findKonsRoot(process.cwd());
  if (!root)
    throw new Error(
      "Not inside a Kitsuden project or a kons repository. Pass --dir <folder with models> or --root <dir>."
    );
  const konOpt = o.kon ?? (o.root ? undefined : findEnclosingKon(process.cwd())) ?? undefined;
  const kons = konsDirOf(root);
  const list: ModelsTarget[] = [];
  for (const name of existsSync(kons) ? readdirSync(kons).sort() : []) {
    if (!name.startsWith("kon-")) continue;
    if (konOpt && name !== `kon-${konOpt.replace(/^kon-/, "")}`) continue;
    const dir = join(kons, name);
    const files = modelFiles(dir);
    if (files.length === 0) continue;
    list.push({ dir, kon: shortKonOf(dir), files, migrations: join(dir, "migrations") });
  }
  if (konOpt && list.length === 0) {
    throw new Error(`kon-${konOpt.replace(/^kon-/, "")} has no models (*.model.ts or models.ts)`);
  }
  return list;
}

/** The next `NNNN` in the migrations folder. */
export function nextNumber(migrations: string): string {
  let max = -1;
  if (existsSync(migrations)) {
    for (const f of readdirSync(migrations)) {
      const m = /^(\d{4})_.*\.sql$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(4, "0");
}

const MARK = "@@KITSUDEN_MODELS@@";

const RUNNER = `// Generated by kitsuden makemigrations; deleted when it finishes.
import { pathToFileURL } from "node:url";
import * as shared from "@kitsuden/shared";
const args = JSON.parse(process.env.KITSUDEN_MAKEMIGRATIONS_ARGS ?? "{}");
if (typeof shared.generateModelMigration !== "function") {
  throw new Error("@kitsuden/shared has no generateModelMigration: rebuild it (pnpm --filter @kitsuden/shared build)");
}
const models = [];
for (const file of args.files) {
  const mod = await import(pathToFileURL(file).href);
  for (const value of Object.values(mod)) {
    if (shared.isModel(value) && !models.includes(value)) models.push(value);
  }
}
const r = shared.generateModelMigration(args.previous, models, {
  kon: args.kon,
  allowDestructive: args.destructiveOne === true,
});
const header = shared.migrationHeader(r.changes, r.warnings);
console.log("${MARK}" + JSON.stringify({ ...r, header, models: models.map((m) => m.name) }));
`;

/** Loads the models with bun and returns the migration computed by @kitsuden/shared. */
function runRunner(
  d: ModelsTarget,
  previous: Snapshot | null,
  o: MakemigrationsOptions
): RunnerResult {
  const runner = join(d.dir, `__kitsuden_makemigrations_${process.pid}.ts`);
  writeFileSync(runner, RUNNER, "utf8");
  try {
    const bun = buildInvocation(o.bun ?? "bun", ["run", runner]);
    const r = spawnSync(bun.file, bun.args, {
      windowsVerbatimArguments: bun.windowsVerbatimArguments,
      cwd: d.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        KITSUDEN_MAKEMIGRATIONS_ARGS: JSON.stringify({
          files: d.files,
          previous,
          kon: d.kon,
          destructiveOne: o.allowDestructive === true,
        }),
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error)
      throw new Error(`could not run bun (${r.error.message}). Install bun: https://bun.sh`);
    const output = r.stdout ?? "";
    const line = output.split(/\r?\n/).find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line) {
      throw new Error(`loading the models failed:\n${(r.stderr || output).trim()}`);
    }
    return JSON.parse(line.slice(MARK.length)) as RunnerResult;
  } finally {
    rmSync(runner, { force: true });
  }
}

/** Generates (and writes, unless `dryRun`) the migration of each target. */
export async function generateModelMigrations(
  o: MakemigrationsOptions
): Promise<MakemigrationsResult[]> {
  const results: MakemigrationsResult[] = [];
  const name = (o.name ?? "models").replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "models";
  for (const d of modelsTargets(o)) {
    if (d.files.length === 0) throw new Error(`${d.dir} has no models (*.model.ts or models.ts)`);
    const snapshotPath = join(d.migrations, SNAPSHOT);
    const readFrom = existsSync(snapshotPath) ? snapshotPath : null;
    const previous = readFrom ? (JSON.parse(readFileSync(readFrom, "utf8")) as Snapshot) : null;
    const r = runRunner(d, previous, o);
    if (!r.sql) {
      results.push({
        target: d,
        models: r.models,
        changes: [],
        warnings: r.warnings,
        file: null,
        sql: "",
      });
      continue;
    }
    const file = join(d.migrations, `${nextNumber(d.migrations)}_${name}.sql`);
    const sql = `${r.header}${r.sql}\n`;
    if (!o.dryRun) {
      await mkdir(d.migrations, { recursive: true });
      await writeFile(file, sql, "utf8");
      await writeFile(snapshotPath, `${JSON.stringify(r.snapshot, null, 2)}\n`, "utf8");
    }
    results.push({
      target: d,
      models: r.models,
      changes: r.changes,
      warnings: r.warnings,
      file,
      sql,
    });
  }
  return results;
}

/** `kitsuden makemigrations` (models). */
export async function makemigrationsOfModels(o: MakemigrationsOptions): Promise<number> {
  const results = await generateModelMigrations(o);
  if (results.length === 0) {
    console.log(
      chalk.gray(
        "No models found (*.model.ts or models.ts in packages/kons/kon-*/). Nothing to do."
      )
    );
    return 0;
  }
  let writtenItems = 0;
  for (const r of results) {
    const where = relative(process.cwd(), r.target.dir) || ".";
    if (!r.file) {
      console.log(chalk.gray(`  ${where}: no changes (${r.models.join(", ")})`));
      continue;
    }
    writtenItems++;
    console.log(chalk.yellow(`  ${where}:`) + ` ${r.changes.length} change(s)`);
    for (const c of r.changes) console.log(`    · ${c}`);
    for (const a of r.warnings) console.log(chalk.red(`    ! ${a}`));
    if (o.dryRun) {
      console.log(chalk.cyan(`\n-- ${relative(process.cwd(), r.file)} (dry run)\n`) + r.sql);
    } else {
      console.log(chalk.green(`    ✓ ${relative(process.cwd(), r.file)}`));
    }
  }
  if (writtenItems && !o.dryRun) {
    console.log(
      chalk.gray(
        "\nReview the SQL, then apply it with the migration runner (it never runs by itself)."
      )
    );
  }
  return writtenItems;
}

// ── make model ──────────────────────────────────────────────────────────────

export interface MakeModelOptions {
  kon?: string;
  dir?: string;
  root?: string;
  force?: boolean;
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function aKebab(s: string): string {
  return s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function aCamel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function modelTemplate(name: string): string {
  const variable = aCamel(name);
  return `/**
 * Model '${name}' — declared ONCE (docs/agents/models.md).
 *
 * From this declaration Kitsuden derives the table, the migration
 * (\`kitsuden makemigrations\`), REST + OpenAPI + MCP operations, validation,
 * RLS by the access policy, the agent scopes ${name}:read / ${name}:write and
 * the admin panel view. Register it in the kon: defineModelsKon({ models: [${variable}] }).
 */
import { defineModel, field } from "@kitsuden/shared";

export const ${variable} = defineModel({
  name: "${name}",
  description: "TODO: what one ${name} is, for humans and agents",
  fields: {
    title: field.text({ max: 200, required: true, tag: "Title" }),
    notes: field.longText({ tag: "Notes" }),
  },
  // REQUIRED. Who reads: "public" | "owner" | "staff". Who writes: "owner" | "staff".
  // Agents never write without the ${name}:write scope.
  access: { read: "owner", write: "owner" },
});
`;
}

export async function makeModel(rawName: string, o: MakeModelOptions): Promise<string[]> {
  const name = aKebab(rawName);
  if (!SLUG.test(name))
    throw new Error(
      `'${rawName}' is not a valid model name (kebab-case singular, e.g. note, task-item)`
    );
  const konOpt =
    o.kon ?? (o.dir || o.root ? undefined : findEnclosingKon(process.cwd())) ?? undefined;
  let dir: string;
  if (o.dir) dir = resolve(o.dir);
  else if (konOpt) {
    const root = o.root ? resolve(o.root) : findKonsRoot(process.cwd());
    if (!root)
      throw new Error(
        "Not inside a Kitsuden project or a kons repository. Pass --root <dir> or --dir <folder>."
      );
    const shortOne = aKebab(konOpt).replace(/^kon-/, "");
    const dirKon = join(konsDirOf(root), `kon-${shortOne}`);
    if (!existsSync(join(dirKon, "kon.json"))) {
      throw new Error(
        `kon-${shortOne} does not exist here. Create it first: kitsuden make kon ${shortOne}`
      );
    }
    dir = join(dirKon, "src");
  } else {
    throw new Error(
      "Say where the model lives: --kon <name> or --dir <folder> (e.g. apps/api/src/models)"
    );
  }
  const file = join(dir, `${name}.model.ts`);
  if (existsSync(file) && !o.force)
    throw new Error(`Already exists: ${file} (use --force to overwrite)`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, modelTemplate(name), "utf8");
  return [
    `created ${file}`,
    `register it: defineModelsKon({ id, name, version, models: [${aCamel(name)}] }) from @kitsuden/engine`,
    `then: kitsuden makemigrations${konOpt ? ` --kon ${aKebab(konOpt).replace(/^kon-/, "")}` : ` --dir ${relative(process.cwd(), dir) || "."}`}`,
  ];
}
