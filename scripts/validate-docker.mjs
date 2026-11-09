/**
 * Static validation of the deployment layer
 * ============================================================================
 *
 * The 1,300 tests and the typecheck do not look at the Dockerfiles or the
 * compose files. This was discovered the hard way: `Dockerfile.prod` copied
 * `packages/orm`, a package that has not existed since a refactor, and the
 * build blew up at line 52 after 45 seconds downloading layers. Even worse,
 * `packages/codegen` —which the API imports on the FIRST line of
 * `routes/codegen.ts`— was never copied into the final image: the build would
 * have passed and the container would not have started.
 *
 * This checks, without building anything:
 *
 *   1. That every `COPY` points to something that exists.
 *   2. That every `pnpm --filter <package>` names a real workspace package.
 *   3. That the `dockerfile:` entries and mounts of the compose files exist.
 *   4. That the variables marked mandatory (`${VAR:?}`) are in `.env`.
 *
 * It takes milliseconds. The build takes minutes and fails halfway.
 *
 *   node scripts/validate-docker.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const problems = [];
const warning = (f, l, m) => problems.push({ f, l, m });

// ── 1. Every COPY of every Dockerfile points to something that exists ───────
const dockerfiles = readdirSync("docker").filter((f) => f.startsWith("Dockerfile"));
for (const df of dockerfiles) {
  const route = join("docker", df);
  readFileSync(route, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const m = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
      if (!m) return;
      const parts = m[1].split(/\s+/).filter((p) => !p.startsWith("--"));
      const sources = parts.slice(0, -1);
      for (const f of sources) {
        if (f.includes("*")) {
          // Glob: the FIXED part before the first wildcard is checked.
          const sets = f.slice(0, f.indexOf("*")).replace(/\/$/, "");
          if (sets && !existsSync(sets))
            warning(route, i + 1, `glob without a base directory: ${f}`);
          continue;
        }
        if (!existsSync(f)) warning(route, i + 1, `COPY of something that does NOT exist: ${f}`);
      }
    });
}

// ── 2. Every `pnpm --filter <package>` exists in the workspace ──────────────
const names = new Set();
for (const base of ["packages", "apps"]) {
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const pj = join(base, d.name, "package.json");
    if (existsSync(pj)) names.add(JSON.parse(readFileSync(pj, "utf8")).name);
    const sub = join(base, d.name);
    for (const s of readdirSync(sub, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const spj = join(sub, s.name, "package.json");
      if (existsSync(spj)) names.add(JSON.parse(readFileSync(spj, "utf8")).name);
    }
  }
}
for (const df of dockerfiles) {
  const route = join("docker", df);
  readFileSync(route, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const m = /--filter\s+"?(@[\w/*-]+)"?/.exec(line);
      if (!m) return;
      const n = m[1];
      if (n.includes("*")) return;
      if (!names.has(n)) warning(route, i + 1, `--filter to a nonexistent package: ${n}`);
    });
}

// ── 3. Compose: context, dockerfile and mounts ──────────────────────────────
for (const cf of readdirSync(".").filter((f) => /^docker-compose.*\.ya?ml$/.test(f))) {
  const text = readFileSync(cf, "utf8");
  text.split(/\r?\n/).forEach((line, i) => {
    const df = /dockerfile:\s*(\S+)/.exec(line);
    if (df && !existsSync(df[1])) warning(cf, i + 1, `nonexistent dockerfile: ${df[1]}`);
    const vol = /^\s+-\s+(\.\/[^\s:]+):/.exec(line);
    if (vol && !existsSync(vol[1])) warning(cf, i + 1, `nonexistent mount: ${vol[1]}`);
  });

  // Mandatory variables (`:?`) present in .env
  const requiredOnes = [...text.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]);
  if (requiredOnes.length && existsSync(".env")) {
    const env = readFileSync(".env", "utf8");
    for (const v of new Set(requiredOnes)) {
      if (!new RegExp(`^${v}=.+`, "m").test(env))
        warning(cf, 0, `${v} is mandatory and missing from .env`);
    }
  }
}

if (problems.length === 0) {
  console.log("DOCKER VALIDATION: no problems");
} else {
  console.log(`DOCKER VALIDATION: ${problems.length} problem(s)\n`);
  for (const p of problems) console.log(`  ${p.f}${p.l ? ":" + p.l : ""}  ${p.m}`);
}
