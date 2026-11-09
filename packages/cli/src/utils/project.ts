import fs from "fs/promises";
import path from "path";

export async function findProjectRoot(cwd: string = process.cwd()): Promise<string> {
  let current = cwd;
  while (true) {
    try {
      await fs.access(path.join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Fallback: use cwd if pnpm-workspace.yaml is not found
        return cwd;
      }
      current = parent;
    }
  }
}
