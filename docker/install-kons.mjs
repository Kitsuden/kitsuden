#!/usr/bin/env node
/**
 * Installs into the image the kons declared in KITSUDEN_KONS.
 *
 *   node docker/install-kons.mjs <source-folder>
 *
 * Called by docker/Dockerfile.prod with the additional build context `kons`
 * mounted at <source-folder> (by default the empty `kons` stage; a
 * deployment that wants kons points it at a kitsuden-kons checkout):
 *
 *   docker compose build --build-arg KITSUDEN_KONS="blog,wiki" …
 *   (additional_contexts: kons: ../kitsuden-kons)
 *
 * It does the same as `kitsuden kon add` without pnpm or migrations (those go in
 * the image's `pnpm install` and at container startup):
 *
 *   · copies each kon to /app/packages/kons/<id>/ (without node_modules or dist);
 *   · checks that their kon dependencies are also in the list (a
 *     kon missing from the image cannot be added later without rebuilding);
 *   · writes /app/kitsuden.kons.json, which is what the API reads to know
 *     what is installed. With no kons, the file stays empty: the API starts
 *     with the core only.
 *
 * No dependencies: runs with the base image's node before `pnpm install`.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const origin = process.argv[2];
const root = process.cwd();
const CORE = new Set(["kon-datasets", "kon-media", "kon-blocks"]);
const NOT_COPIED = new Set(["node_modules", "dist", ".git", "coverage"]);
// Same rules as `kitsuden kon add` (packages/cli/src/kons/installation.ts).
const KON_ID = /^kon-[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "prepare",
  "preprepare",
  "postprepare",
  "prepublish",
  "prepack",
  "postpack",
  "pnpm:devPreinstall",
  "dependencies",
]);

function fail(message) {
  console.error(`install-kons: ${message}`);
  process.exit(1);
}

const konIdOf = (n) => {
  const clean = n.trim().replace(/^@kitsuden\//, "");
  const id = clean.startsWith("kon-") ? clean : `kon-${clean}`;
  if (!KON_ID.test(id)) fail(`invalid kon id ${JSON.stringify(n)}: an id must match ${KON_ID}`);
  return id;
};

function readJson(route) {
  try {
    return JSON.parse(readFileSync(route, "utf8"));
  } catch {
    return null;
  }
}

function manifest(dir) {
  const k = readJson(join(dir, "kon.json"));
  if (k?.id) return k;
  const pkg = readJson(join(dir, "package.json"));
  if (pkg?.kitsuden)
    return { ...pkg.kitsuden, id: pkg.kitsuden.id || pkg.name, version: pkg.version };
  return null;
}

function dirOf(id) {
  for (const c of [
    join(origin, "kons", id),
    join(origin, id),
    join(origin, "packages", "kons", id),
  ]) {
    if (existsSync(c) && manifest(c)) return c;
  }
  return null;
}

function dependencies(dir, m) {
  const deps = new Set();
  const d = m.dependencies;
  for (const list of Array.isArray(d) ? [d] : [d?.kons, d?.required]) {
    if (Array.isArray(list))
      for (const x of list) if (typeof x === "string" && x.startsWith("kon-")) deps.add(konIdOf(x));
  }
  const pkg = readJson(join(dir, "package.json")) ?? {};
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const n of Object.keys(pkg[field] ?? {}))
      if (n.startsWith("@kitsuden/kon-")) deps.add(konIdOf(n));
  }
  return [...deps].filter((x) => !CORE.has(x) && x !== konIdOf(m.id));
}

const requests = [
  ...new Set(
    (process.env.KITSUDEN_KONS ?? "")
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(konIdOf)
  ),
].filter((id) => !CORE.has(id));

const kons = {};
if (requests.length) {
  if (!origin || !existsSync(origin))
    fail(`KITSUDEN_KONS asks for kons but there is no source (${origin}).`);
  const plans = [];
  for (const id of requests) {
    const dir = dirOf(id);
    if (!dir)
      fail(
        `${id} is not in the \`kons\` context (${origin}). Does additional_contexts point to kitsuden-kons?`
      );
    const m = manifest(dir);
    if (konIdOf(m.id) !== id)
      fail(`${id}: its folder declares a different kon (${JSON.stringify(m.id)})`);
    // `pnpm rebuild` in the image runs the scripts of workspace packages.
    const forbiddenItems = Object.keys(readJson(join(dir, "package.json"))?.scripts ?? {}).filter(
      (s) => FORBIDDEN_SCRIPTS.has(s)
    );
    if (forbiddenItems.length)
      fail(
        `${id}: lifecycle scripts are not allowed in an installed kon (${forbiddenItems.join(", ")})`
      );
    plans.push({ id, dir, m });
  }
  const areMissing = [];
  for (const p of plans) {
    for (const dep of dependencies(p.dir, p.m))
      if (!requests.includes(dep)) areMissing.push(`${p.id} → ${dep}`);
  }
  if (areMissing.length) fail(`missing dependencies in KITSUDEN_KONS: ${areMissing.join(", ")}`);

  for (const p of plans) {
    const target = join(root, "packages", "kons", p.id);
    cpSync(p.dir, target, {
      recursive: true,
      filter: (src) => !NOT_COPIED.has(basename(src)) && !src.endsWith(".tsbuildinfo"),
    });
    const pkg = readJson(join(p.dir, "package.json")) ?? {};
    kons[p.id] = {
      source: "docker:kons",
      ...(pkg.version || p.m.version ? { version: pkg.version || p.m.version } : {}),
      ...(typeof p.m.sdk === "number" ? { sdk: p.m.sdk } : {}),
      mode: "copy",
    };
    console.log(`install-kons: ${p.id}${pkg.version ? `@${pkg.version}` : ""}`);
  }
}

writeFileSync(
  join(root, "kitsuden.kons.json"),
  JSON.stringify(
    {
      $comment: "Generated at image build by docker/install-kons.mjs from KITSUDEN_KONS.",
      // sorted: two builds with the same list produce the same file
      kons: Object.fromEntries(Object.entries(kons).sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2
  ) + "\n"
);
console.log(`install-kons: ${Object.keys(kons).length} kon(s) in the image`);
