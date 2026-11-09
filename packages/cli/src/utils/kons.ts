import fs from "fs/promises";
import path from "path";

import { findProjectRoot } from "./project.js";

export async function loadKons(): Promise<{ models: Record<string, any> }> {
  const projectRoot = await findProjectRoot();
  const konsPath = path.join(projectRoot, "packages", "kons");
  const models: Record<string, any> = {};

  try {
    const kons = await fs.readdir(konsPath);

    for (const kon of kons) {
      const schemaPath = path.join(konsPath, kon, "schema.ts");

      try {
        const module = await import(schemaPath);

        // Extract exported tables
        for (const [key, value] of Object.entries(module)) {
          if (key !== "default" && !key.startsWith("_")) {
            models[key] = value;
          }
        }
      } catch {
        // Ignore if it has no schema
      }
    }
  } catch {
    // Ignore if the directory does not exist
  }

  return { models };
}
