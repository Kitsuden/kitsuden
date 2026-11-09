/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAKE COMMAND — Scaffolding generators (artisan / manage.py style)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A model (defineModel, see models.ts and docs/agents/models.md):
 *   kitsuden make model note --kon notes   → packages/kons/kon-notes/src/note.model.ts
 *
 * A whole kon (see make-kon.ts):
 *   kitsuden make kon recipes            → packages/kons/kon-recipes/ + tests/unit/kon-recipes.test.ts
 *
 * Inside a kon (the shape of the real kons: flat files at its root):
 *   kitsuden make policy Draft --kon blog  → adds definePolicy("blog-draft") to
 *                                            register<Blog>Policy() in <kon>/blog.policy.ts
 *                                            (creates the file if it does not exist)
 *   kitsuden make request CreatePost --kon blog → <kon>/create-post.request.ts
 *   kitsuden make job SendEmail --kon blog      → <kon>/send-email.job.ts
 *   kitsuden make test payment --kon blog       → tests/unit/kon-blog-payment.test.ts (vitest)
 *
 * In the app (apps/api):
 *   kitsuden make request CreatePost   → apps/api/src/requests/create-post.request.ts
 *   kitsuden make job SendEmail        → apps/api/src/jobs/send-email.job.ts
 *   kitsuden make test payment         → apps/api/src/tests-unit/payment.test.ts (bun:test)
 *
 * ── WHY `policy` REQUIRES --kon ────────────────────────────────────────────
 *
 * Before, it generated `apps/api/src/policies/<x>.policy.ts`, a folder that does not
 * exist in the repo and that nothing imports: the policy was left unregistered and the
 * resource denied for everyone (deny-by-default) with no warning. The real
 * policies live in the kon that owns the resource (`<kon>.policy.ts`, with
 * `register<Kon>Policy()` called on import) or in packages/core.
 *
 * A kon's tests go to tests/unit and use vitest: bun's `mock.module` leaks
 * between files, and the kon suite with the clean stack is the vitest one.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import chalk from "chalk";

import { findEnclosingKon, findKonsRoot, konsDirOf, makeKonCommand } from "./make-kon.js";
import { makeModel } from "./models.js";

type MakeKind = "kon" | "model" | "policy" | "request" | "job" | "test";
const VALID: MakeKind[] = ["kon", "model", "policy", "request", "job", "test"];

export interface MakeOptions {
  force?: boolean;
  kon?: string;
  /** make model: folder where the model goes (the app, e.g. apps/api/src/models). */
  dir?: string;
  root?: string;
  icon?: string;
  title?: string;
  description?: string;
  /** make kon: a new kons repository of your own (`true` or a folder). */
  standalone?: boolean | string;
}

function toKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}
function toPascal(s: string): string {
  return s
    .replace(/[-_\s]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ""))
    .replace(/^(.)/, (_, ch) => ch.toUpperCase());
}
function toCamel(s: string): string {
  const p = toPascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

interface Target {
  root: string;
  /** The kon's folder (packages/kons/kon-x) or null for the app. */
  dirKon: string | null;
  /** Short name of the kon, without prefix (blog for kon-blog). */
  shortKon: string | null;
}

function resolveTarget(options: MakeOptions): Target {
  const root = options.root ? path.resolve(options.root) : findKonsRoot(process.cwd());
  if (!root) {
    throw new Error(
      "Not inside a Kitsuden project (packages/kons) or a kons repository (kons/). Pass --root <dir>."
    );
  }
  const konsDir = konsDirOf(root);
  const konOpt =
    options.kon ?? (options.root ? undefined : findEnclosingKon(process.cwd())) ?? undefined;
  if (!konOpt) {
    // A kons repository has no app: everything there belongs to a kon.
    if (!existsSync(path.join(root, "apps", "api"))) {
      throw new Error("This is a kons repository: say which kon with --kon <name>.");
    }
    return { root, dirKon: null, shortKon: null };
  }

  const shortKon = toKebab(konOpt).replace(/^kon-/, "");
  const dirKon = path.join(konsDir, `kon-${shortKon}`);
  if (!existsSync(path.join(dirKon, "kon.json"))) {
    throw new Error(
      `${path.relative(root, dirKon).split(path.sep).join("/")} does not exist. Create it first: kitsuden make kon ${shortKon}`
    );
  }
  return { root, dirKon, shortKon };
}

// ── policy ──────────────────────────────────────────────────────────────────

function policyBlock(resource: string, Pascal: string): string {
  return `  // ${Pascal}: deny-by-default. Adjust the rules; an action with no rule is denied.
  definePolicy<${Pascal}Resource>("${resource}", {
    view: (user, r) => r.published === true || user?.role === "admin" || user?.role === "editor",
    create: (user) => user?.role === "admin" || user?.role === "editor",
    update: (user) => user?.role === "admin" || user?.role === "editor",
    delete: (user) => user?.role === "admin",
  });
`;
}

function policyInterface(Pascal: string): string {
  return `export interface ${Pascal}Resource {
  published?: boolean | null;
}
`;
}

/**
 * Policy inside a kon: a single `<kon>.policy.ts` with
 * `register<Kon>Policy()`, like kon-booking or kon-directory.
 */
async function makePolicy(name: string, d: Target): Promise<string[]> {
  if (!d.dirKon || !d.shortKon) {
    throw new Error(
      "Policies live in the kon that owns the resource: use --kon <name> " +
        "(e.g. kitsuden make policy Draft --kon blog). apps/api has no policies folder that anything loads."
    );
  }
  const k = d.shortKon;
  const K = toPascal(k);
  const kebab = toKebab(name);
  const resource = kebab === k ? k : `${k}-${kebab}`;
  const Pascal = toPascal(name);
  const file = path.join(d.dirKon, `${k}.policy.ts`);
  const register = `register${K}Policy`;

  if (!existsSync(file)) {
    const content = `/**
 * ${K} — Authorization policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the kon's policies.
 * \`${register}()\` exists because the tests call \`resetAuthz()\` and they have
 * to be registered again.
 */
import { definePolicy } from "@kitsuden/engine";

${policyInterface(Pascal)}
export function ${register}(): void {
${policyBlock(resource, Pascal)}}

${register}();
`;
    await fs.writeFile(file, content, "utf8");
    return [
      `created ${file}`,
      `wire it: in ${k}.routes.ts add \`import { ${register} } from "./${k}.policy";\` and call ${register}() at module level`,
      `publish it: add "${k}.policy.ts" to files[] in package.json`,
      `use it: await authorize(user, "update", resource, "${resource}")`,
    ];
  }

  const source = await fs.readFile(file, "utf8");
  if (source.includes(`"${resource}"`)) {
    throw new Error(`${path.basename(file)} already defines a policy "${resource}"`);
  }
  const opening = new RegExp(`export function ${register}\\(\\)(?::\\s*void)?\\s*\\{\\n`);
  const m = source.match(opening);
  if (!m || m.index === undefined) {
    throw new Error(
      `${path.basename(file)} has no \`export function ${register}(): void {\`. ` +
        `Add this inside the function that registers the kon's policies:\n\n${policyBlock(resource, Pascal)}`
    );
  }
  const cut = m.index + m[0].length;
  let next = source.slice(0, cut) + policyBlock(resource, Pascal) + source.slice(cut);
  // The interface, right before the registration function.
  next = next.replace(m[0], `${policyInterface(Pascal)}\n${m[0]}`);
  if (!/import\s*\{[^}]*\bdefinePolicy\b[^}]*\}\s*from\s*"@kitsuden\/engine"/.test(next)) {
    next = `import { definePolicy } from "@kitsuden/engine";\n${next}`;
  }
  await fs.writeFile(file, next, "utf8");
  return [
    `added policy "${resource}" to ${register}() in ${file}`,
    `use it: await authorize(user, "update", resource, "${resource}")`,
  ];
}

// ── request / job / test ────────────────────────────────────────────────────

function template(
  kind: "request" | "job" | "test",
  name: string,
  d: Target
): { file: string; content: string; notes: string[] } {
  const kebab = toKebab(name);
  const Pascal = toPascal(name);
  const camel = toCamel(name);
  const app = path.join(d.root, "apps", "api", "src");
  const inKon = (f: string) => path.join(d.dirKon!, f);
  const publish = d.dirKon
    ? [`publish it: add the file to files[] in the kon's package.json once index.ts imports it`]
    : [];

  switch (kind) {
    case "request":
      return {
        file: d.dirKon
          ? inKon(`${kebab}.request.ts`)
          : path.join(app, "requests", `${kebab}.request.ts`),
        notes: publish,
        content: `import { validateRequest, validated } from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";
import type { Context } from "hono";

/** Schema of the request ${Pascal}. */
export const ${Pascal}Schema = z.object({
  // TODO: define your fields
  title: z.string().min(1, "Title is required"),
});

export type ${Pascal}Input = z.infer<typeof ${Pascal}Schema>;

/** Ready-to-use middleware: router.post("/x", ${camel}Request, handler). */
export const ${camel}Request = validateRequest(${Pascal}Schema, "json");

/** Reads the validated, typed data inside the handler. */
export const get${Pascal} = (c: Context): ${Pascal}Input => validated<${Pascal}Input>(c, "json");
`,
      };

    case "job":
      return {
        file: d.dirKon ? inKon(`${kebab}.job.ts`) : path.join(app, "jobs", `${kebab}.job.ts`),
        notes: publish,
        content: `export interface ${Pascal}Payload {
  // TODO: define the job payload
  id: string;
}

/**
 * Job ${Pascal}. Run by the worker/queue.
 */
export async function ${camel}Job(payload: ${Pascal}Payload): Promise<void> {
  console.log("[job:${camel}] start", payload);
  // TODO: implement
  console.log("[job:${camel}] done");
}
`,
      };

    case "test":
      if (d.dirKon) {
        return {
          file: path.join(d.root, "tests", "unit", `kon-${d.shortKon}-${kebab}.test.ts`),
          notes: [
            existsSync(path.join(d.root, "apps", "api"))
              ? `run it: pnpm test:unit -- kon-${d.shortKon}-${kebab}`
              : `run it: pnpm test -- kon-${d.shortKon}-${kebab}`,
          ],
          content: `import { describe, expect, it } from "vitest";

describe("kon-${d.shortKon}: ${Pascal}", () => {
  it("TODO: write your first assertion", () => {
    expect(true).toBe(true);
  });
});
`,
        };
      }
      return {
        file: path.join(app, "tests-unit", `${kebab}.test.ts`),
        notes: [`run it: pnpm test:api -- ${kebab}`],
        content: `import { describe, it, expect } from "bun:test";

describe("${Pascal}", () => {
  it("TODO: write your first assertion", () => {
    expect(true).toBe(true);
  });
});
`,
      };
  }
}

/**
 * In a kons repository, keeps the kon's package.json `files` in step after a generator added a
 * file (`scripts/kon-sync.mjs`, the repo's own tool): a new file is shipped without anyone
 * remembering to list it. Elsewhere it does nothing.
 */
function syncKonFiles(root: string | null, shortKon: string | null | undefined): void {
  if (!root || !shortKon) return;
  const script = path.join(root, "scripts", "kon-sync.mjs");
  if (!existsSync(script)) return;
  const r = spawnSync(process.execPath, [script, `kon-${shortKon.replace(/^kon-/, "")}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status === 0) console.log(chalk.gray(`  package.json files updated (kon:sync)`));
  else console.warn(chalk.yellow(`! kon:sync failed: ${(r.stderr || r.stdout).trim()}`));
}

export async function makeCommand(
  kind: string,
  name: string,
  options: MakeOptions = {}
): Promise<void> {
  if (!VALID.includes(kind as MakeKind)) {
    console.error(chalk.red(`Unknown kind '${kind}'. Use: ${VALID.join(" | ")}`));
    process.exit(1);
  }
  if (!name) {
    console.error(chalk.red(`Missing name. Example: kitsuden make ${kind} MyName`));
    process.exit(1);
  }

  // defineModel: docs/agents/models.md
  if (kind === "model") {
    try {
      const inferredKon =
        options.kon ??
        (options.dir || options.root ? undefined : findEnclosingKon(process.cwd())) ??
        undefined;
      const notes = await makeModel(name, {
        kon: inferredKon,
        dir: options.dir,
        root: options.root,
        force: options.force,
      });
      console.log(chalk.green("✔ model"));
      for (const n of notes) console.log(`  ${n}`);
      if (inferredKon) syncKonFiles(findKonsRoot(options.root ?? process.cwd()), inferredKon);
    } catch (e) {
      console.error(chalk.red(`✖ ${(e as Error).message}`));
      process.exit(1);
    }
    return;
  }

  if (kind === "kon") {
    if (options.kon) {
      console.error(chalk.red("`make kon` takes the kon name as its argument, not --kon"));
      process.exit(1);
    }
    await makeKonCommand(name, options);
    return;
  }

  try {
    const target = resolveTarget(options);
    const tag = target.shortKon ? chalk.magenta(`[kon-${target.shortKon}]`) : chalk.gray("[app]");

    if (kind === "policy") {
      const notes = await makePolicy(name, target);
      console.log(chalk.green("✔ policy") + ` ${tag}`);
      for (const n of notes) console.log(`  ${n}`);
      syncKonFiles(target.root, target.shortKon);
      return;
    }

    const {
      file,
      content,
      notes: notes,
    } = template(kind as "request" | "job" | "test", name, target);
    if (existsSync(file) && !options.force) {
      throw new Error(`Already exists: ${file} (use --force to overwrite)`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    console.log(chalk.green(`✔ ${kind}`) + ` ${tag} ` + path.relative(process.cwd(), file));
    for (const n of notes) console.log(`  ${n}`);
    syncKonFiles(target.root, target.shortKon);
  } catch (e) {
    console.error(chalk.red(`✖ ${(e as Error).message}`));
    process.exit(1);
  }
}
