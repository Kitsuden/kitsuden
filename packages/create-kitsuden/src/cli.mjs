/**
 * The command: `npm create kitsuden [folder] [-- options]`.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { DEFAULT_REGISTRY, DEFAULT_SOURCE, scaffold, VERSION } from "./index.mjs";

const HELP = `create-kitsuden ${VERSION}: a new Kitsuden project

  npm create kitsuden@latest [folder] -- [options]

Options:
  --mode <docker|local>  docker (default): docker-compose.yml + .env for the published
                         images; nothing is downloaded to scaffold.
                         local: a checkout of the source, to run with Bun and pnpm.
  --instance <name>      prefix of containers and volumes (docker; default: from the folder)
  --registry <prefix>    image registry (default ${DEFAULT_REGISTRY})
  --image-tag <tag>      image tag (default ${VERSION})
  --source <url|path>    local mode: where to clone from (default ${DEFAULT_SOURCE});
                         a path to a checkout you have works offline
  --ref <branch|tag>     local mode: what to clone
  --api-port, --admin-port, --db-port, --valkey-port <n>   fixed ports
  --skip-checks          do not look for free ports or for an install with the same name
  -y, --yes              ask nothing (folder defaults to "kitsuden-app")
  -h, --help
`;

const OPTIONS = {
  mode: { type: "string" },
  instance: { type: "string" },
  registry: { type: "string" },
  "image-tag": { type: "string" },
  source: { type: "string" },
  ref: { type: "string" },
  "api-port": { type: "string" },
  "admin-port": { type: "string" },
  "db-port": { type: "string" },
  "valkey-port": { type: "string" },
  "skip-checks": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
};

function port(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`--${name}: not a port (${value})`);
  return n;
}

export async function main(
  argv = process.argv.slice(2),
  io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr.write(`${e.message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    io.stdout.write(HELP);
    return 0;
  }
  const interactive = !v.yes && Boolean(io.stdin.isTTY);
  let dir = positionals[0];
  let mode = v.mode;
  if (interactive && (!dir || !mode)) {
    const rl = createInterface({ input: io.stdin, output: io.stdout });
    try {
      if (!dir)
        dir = (await rl.question("Project folder (kitsuden-app): ")).trim() || "kitsuden-app";
      if (!mode) {
        const a = (
          await rl.question(
            "How will it run?\n  1) Docker, with the published images (recommended)\n  2) Local development from the source (Bun + pnpm)\nChoose 1 or 2 (1): "
          )
        ).trim();
        mode = a === "2" || a === "local" ? "local" : "docker";
      }
    } finally {
      rl.close();
    }
  }
  dir ??= "kitsuden-app";
  mode ??= "docker";

  try {
    const ports = {};
    for (const k of ["api", "admin", "db", "valkey"]) {
      const p = port(v[`${k}-port`], `${k}-port`);
      if (p !== undefined) ports[k] = p;
    }
    const started = Date.now();
    const r = await scaffold({
      dir,
      mode,
      instance: v.instance,
      registry: v.registry,
      imageTag: v["image-tag"],
      source: v.source,
      ref: v.ref,
      ports,
      probe: !v["skip-checks"],
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    io.stdout.write(`\nKitsuden project in ${r.dir} (${r.mode}, ${seconds}s).\n`);
    if (r.instance && r.instance !== "kitsuden")
      io.stdout.write(`Instance "${r.instance}": its containers, volumes and ports are its own.\n`);
    if (r.files.length) io.stdout.write(`Wrote: ${r.files.join(", ")}\n`);
    if (r.kept?.length) io.stdout.write(`Kept as they were: ${r.kept.join(", ")}\n`);
    io.stdout.write("The secrets are in .env: never commit it, and keep a copy.\n\nNext:\n");
    for (const step of r.next) io.stdout.write(`  ${step}\n`);
    if (r.mode === "docker")
      io.stdout.write(
        "\nIf `docker pull` says the image does not exist, that version is not published yet:\n" +
          "build the images from a checkout of the repository with ./install.sh instead.\n"
      );
    return 0;
  } catch (e) {
    io.stderr.write(`create-kitsuden: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
}
