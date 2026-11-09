/**
 * File walking for the guard tests.
 *
 * There is a single copy because several tests sweep the repo looking for patterns
 * (shadowed routes, declared tables, panel links) and each one
 * wrote its own recursive `readdirSync` with a slightly different
 * exclusion list. The one that forgot to exclude `node_modules` took
 * minutes; the one that forgot `dist` analyzed the compiled code and
 * reported the same problem twice.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const IGNORED = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".svelte-kit",
  "coverage",
  ".turbo",
  ".claude",
]);

/** All files under `root` whose name ends in any of the extensions. */
export function listFiles(root: string, ...extensions: string[]): string[] {
  const foundItems: string[] = [];

  function traverse(dir: string) {
    let inputs;
    try {
      inputs = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // the directory may not exist in a partial checkout
    }

    for (const input of inputs) {
      const route = join(dir, input.name);
      if (input.isDirectory()) {
        if (IGNORED.has(input.name)) continue;
        traverse(route);
      } else if (extensions.some((ext) => input.name.endsWith(ext))) {
        foundItems.push(route);
      }
    }
  }

  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  traverse(root);
  return foundItems.sort();
}
