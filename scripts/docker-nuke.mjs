/**
 * `pnpm docker:nuke` — deletes the compose stack of THIS folder along with its volumes.
 *
 * It used to be a bare `docker compose down -v --remove-orphans`. The `*_prod`
 * containers live in the same compose project as this folder, so that also
 * deleted production and its named volumes (`kitsuden_postgres_prod`).
 * Found in an audit. It now refuses if anything prod is running or created.
 */
import { execFileSync } from "node:child_process";

const fromProd = execFileSync(
  "docker",
  ["ps", "-a", "--filter", "name=_prod", "--format", "{{.Names}}"],
  {
    encoding: "utf8",
  }
)
  .split(/\r?\n/)
  .filter(Boolean);

if (fromProd.length > 0) {
  console.error(`🛑 There are production containers in this project: ${fromProd.join(", ")}.`);
  console.error("   docker:nuke would also delete their volumes. Nothing is done.");
  process.exit(1);
}

execFileSync("docker", ["compose", "down", "-v", "--remove-orphans"], { stdio: "inherit" });
