/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAP COMMAND — Deterministic System Map (no AI)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   kitsuden map                 # summary of the repo + app map
 *   kitsuden map --json          # full graph as JSON
 *   kitsuden map --toon          # full graph as TOON (via the API)
 *
 * Config: KITSUDEN_API_URL (default http://localhost:3000), KITSUDEN_API_TOKEN.
 */

import chalk from "chalk";

interface MapOptions {
  json?: boolean;
  toon?: boolean;
}

export async function mapCommand(options: MapOptions = {}): Promise<void> {
  const base = process.env.KITSUDEN_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  const token = process.env.KITSUDEN_API_TOKEN;
  const format = options.toon ? "?format=toon" : "";

  try {
    const res = await fetch(`${base}/api/map${format}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (options.toon) {
      console.log(await res.text());
      return;
    }

    const map = (await res.json()) as any;

    if (options.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }

    const s = map.summary ?? {};
    console.log(chalk.cyan("\n🗺️  System Map\n"));
    console.log(`  Endpoints:     ${s.totalEndpoints ?? 0}`);
    console.log(`  Tables (repo): ${s.totalRepoTables ?? 0}`);
    console.log(`  Tables (DB):   ${s.totalDbTables ?? 0}`);
    console.log(`  Kons:        ${s.totalKons ?? 0}`);
    console.log(`  Services:      ${s.totalServices ?? 0}`);
    console.log(`  Libs:          ${s.totalLibs ?? 0}`);
    console.log(`  FK relations:  ${s.totalRelations ?? 0}`);
    console.log(
      chalk.gray(
        `\n  Graph: ${map.graph?.nodes?.length ?? 0} nodes, ${map.graph?.edges?.length ?? 0} edges`
      )
    );
    console.log(chalk.gray("  (use --json for the full graph, --toon for TOON format)\n"));
  } catch (err) {
    console.error(chalk.red(`Failed to reach the API at ${base}: ${(err as Error).message}`));
    console.error(chalk.gray("Is the API running? (kitsuden dev / kitsuden start)"));
    process.exit(1);
  }
}
