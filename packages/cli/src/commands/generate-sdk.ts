import fs from "fs/promises";
import path from "path";

import chalk from "chalk";
import ora from "ora";

import { generateTypedClient } from "./sdk/typed-client.js";
// import { findProjectRoot } from '../utils/project.js';

interface SdkOptions {
  lang?: string;
  output?: string;
  baseUrl?: string;
}

/**
 * Generate frontend SDK code from OpenAPI spec
 */
export async function generateSdkCommand(options: SdkOptions = {}): Promise<void> {
  const lang = options.lang || "typescript";
  const outputDir = options.output || "./src/lib/kitsuden-sdk";
  // 3000 is where the API listens (3001 is the panel). With 3001 the command requested
  // the OpenAPI from the panel and failed with an error that did not mention the port.
  const baseUrl = options.baseUrl || "http://localhost:3000/api";

  console.log(chalk.blue(`🔮 Generating ${lang} SDK...`));

  // Fetch OpenAPI spec from running API
  const spinner = ora("Fetching OpenAPI spec...").start();
  let spec: any;
  try {
    const res = await fetch(`${baseUrl}/docs/openapi.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spec = await res.json();
    spinner.succeed("OpenAPI spec fetched");
  } catch (err: any) {
    spinner.fail(`Could not fetch spec: ${err.message}`);
    console.log(chalk.gray(`  Is the API running at ${baseUrl}?`));
    console.log(chalk.gray(`  Start it with: kitsuden start`));
    process.exit(1);
  }

  // Generate code
  const genSpinner = ora(`Generating ${lang} client...`).start();
  try {
    const code = generateTypedClient(spec, { baseUrl });
    const outPath = path.resolve(outputDir);
    await fs.mkdir(outPath, { recursive: true });
    await fs.writeFile(path.join(outPath, "kitsuden-client.ts"), code, "utf-8");
    genSpinner.succeed(`SDK written to ${outPath}/kitsuden-client.ts`);
  } catch (err: any) {
    genSpinner.fail(`Generation failed: ${err.message}`);
    process.exit(1);
  }

  console.log(chalk.green("\n🎉 SDK generated!"));
  console.log(
    chalk.gray(`   Usage: import { createKitsudenClient } from '${outputDir}/kitsuden-client';`)
  );
}
