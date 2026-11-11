#!/usr/bin/env node
/**
 * Copies tallao components into the admin panel's sources.
 *
 *   git clone https://github.com/tallao-ui/tallao ../tallao   # once, next to this repository
 *   pnpm sync:tallao
 *
 * It reads tallao from `../tallao`; `TALLAO_DIR=<path> pnpm sync:tallao` points it elsewhere.
 *
 * tallao (a Svelte 5 UI kit, MIT, https://github.com/tallao-ui/tallao) is used the shadcn
 * way: components are COPIED into the project, not installed, so the admin owns its copy.
 * `packages/admin/tallao.json` lists the components the admin uses
 * (`{ "components": ["button", "dialog", …], "modules": ["motion"] }`; a module is one of
 * tallao's other entry points, imported as `$lib/tallao/<module>`). This script copies them, everything they
 * import from tallao (sibling components such as `./popover.svelte`, the `internal/` helpers,
 * `i18n.ts`, `utils.ts`…) until nothing new appears, and writes `index.ts` files that export
 * only what was copied. The copy lives in `packages/admin/src/lib/tallao/` and is committed,
 * so the admin builds without tallao on disk. Do not edit it: change tallao and run this again.
 *
 * Inside the admin, `$lib` is the admin's own `src/lib` (with its own `utils.ts`), so every
 * `$lib/...` import in tallao's sources is rewritten to a path relative to the copied file.
 * tallao is written on Windows with CRLF; this repository keeps LF.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const admin = join(root, "packages", "admin");
const TALLAO_REPO = "https://github.com/tallao-ui/tallao";
const tallao = resolve(root, process.env.TALLAO_DIR || "../tallao");
const source = join(tallao, "src", "lib");
const out = join(admin, "src", "lib", "tallao");
const listFile = join(admin, "tallao.json");

function fail(message) {
  console.error(`sync-tallao: ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, "components", "index.ts"))) {
  fail(
    `no tallao at ${tallao}. Clone it next to this repository ` +
      `(git clone ${TALLAO_REPO} ../tallao), or set TALLAO_DIR to a checkout ` +
      `(the folder with src/lib/components).`
  );
}
if (!existsSync(listFile)) fail(`missing ${listFile}`);

const { components, modules = [] } = JSON.parse(readFileSync(listFile, "utf8"));
if (!Array.isArray(components) || components.length === 0) {
  fail(`${listFile} must have a non-empty "components" array`);
}

const read = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** A module specifier, as tallao writes it, to the file it names (relative to src/lib). */
function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec === "$lib" || spec.startsWith("$lib/")) base = spec.slice(5);
  else if (spec.startsWith("./") || spec.startsWith("../"))
    base = posix.join(posix.dirname(fromFile), spec);
  else return null; // a bare package: svelte, @floating-ui/dom…
  base = posix.normalize(base);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.svelte.ts`,
    `${base}.js`,
    `${base}/index.ts`,
  ]) {
    if (isFile(join(source, candidate))) return candidate;
  }
  fail(`${fromFile} imports "${spec}", which tallao does not have`);
}

// Every specifier in `from "…"`, `import "…"` and `import("…")`.
const SPECIFIER = /(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)"([^"]+)"/g;

// Usage examples in doc comments (`import { setLabels } from "tallao"`) are not imports.
const withoutComments = (text) =>
  text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// Components plus what they import, until nothing new appears. `utils.ts` and `i18n.ts`
// always go: the admin's root layout calls `setLabels`.
const files = new Set();
const packages = new Set();
const pending = [
  ...components.map((c) => `components/${c}.svelte`),
  // tallao's other entry points (`"motion"` → `motion/index.ts`), with what they import.
  ...modules.map((m) => `${m}/index.ts`),
  "utils.ts",
  "i18n.ts",
];
while (pending.length) {
  const file = pending.pop();
  if (files.has(file)) continue;
  if (!isFile(join(source, file))) fail(`tallao has no ${file}`);
  files.add(file);
  for (const [, , spec] of withoutComments(read(join(source, file))).matchAll(SPECIFIER)) {
    const target = resolveSpecifier(file, spec);
    if (target) pending.push(target);
    else
      packages.add(
        spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
      );
  }
}

/** Rewrites `$lib/...` to a path relative to the copied file; the rest stays as tallao wrote it. */
function rewrite(file, text) {
  return text.replace(SPECIFIER, (match, head, spec) => {
    if (spec !== "$lib" && !spec.startsWith("$lib/")) return match;
    let rel = posix.relative(posix.dirname(file), posix.normalize(spec.slice(5) || "."));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${head}"${rel}"`;
  });
}

const HEADER =
  "// Copied from tallao by scripts/sync-tallao.mjs. Do not edit: change tallao and run `pnpm sync:tallao`.";

/** An `index.ts` of tallao, keeping only the export lines whose module was copied. */
function filteredIndex(file) {
  const kept = read(join(source, file))
    .split("\n")
    .filter((line) => {
      const m = line.match(/^export\b.*\bfrom\s+"([^"]+)"/);
      if (!m) return false;
      const target = resolveSpecifier(file, m[1]);
      return target !== null && (files.has(target) || target === "components/index.ts");
    });
  return `${HEADER}\n${kept.map((line) => rewrite(file, line)).join("\n")}\n`;
}

rmSync(out, { recursive: true, force: true });
for (const file of files) {
  if (file === "components/index.ts" || file === "index.ts") continue;
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), rewrite(file, read(join(source, file))));
}
mkdirSync(join(out, "components"), { recursive: true });
writeFileSync(join(out, "components", "index.ts"), filteredIndex("components/index.ts"));
writeFileSync(join(out, "index.ts"), filteredIndex("index.ts"));

const version = (() => {
  try {
    return JSON.parse(readFileSync(join(tallao, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();
writeFileSync(
  join(out, "README.md"),
  `# tallao (vendored copy)

Generated by \`scripts/sync-tallao.mjs\` from [tallao](${TALLAO_REPO}) ${version} (MIT).
**Do not edit these files by hand**: the next sync overwrites them.

- To add or remove a component, edit \`packages/admin/tallao.json\` and run
  \`pnpm sync:tallao\` from the repository root. It reads tallao from \`../tallao\`
  (\`git clone ${TALLAO_REPO} ../tallao\`); \`TALLAO_DIR=<path>\` points it elsewhere.
- To change a component, change it in tallao and sync again.
- Import from \`$lib/tallao\` (e.g. \`import { Button, Dialog } from "$lib/tallao";\`).
- The \`--ta-*\` theme variables are mapped onto the admin's \`--kitsuden-*\` ones in
  \`packages/admin/src/style.css\`.
`
);

// A bare package a copied file imports has to be installed in the admin.
const pkg = JSON.parse(readFileSync(join(admin, "package.json"), "utf8"));
const installed = { ...pkg.dependencies, ...pkg.devDependencies };
const missing = [...packages].filter((p) => p !== "svelte" && !(p in installed));

const copied = [...files].filter((f) => !f.endsWith("index.ts")).sort();
console.log(`sync-tallao: ${copied.length} files from ${tallao} into ${out}`);
console.log(`  ${copied.join(", ")}`);
if (missing.length) {
  console.warn(
    `sync-tallao: install in packages/admin: ${missing.join(", ")} (pnpm --filter @kitsuden/admin add …)`
  );
  process.exitCode = 1;
}
