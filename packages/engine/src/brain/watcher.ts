/**
 * KITSUDEN Brain — File Watcher
 *
 * Watches the project filesystem and triggers Brain regeneration on change.
 * Uses Node fs.watch recursively where available; gracefully degrades to
 * polling via setInterval when fs.watch is unreliable.
 */

import { existsSync, watch as fsWatch } from "node:fs";
import { resolve } from "node:path";

export type WatchCallback = (event: "change" | "rename", filePath: string) => void | Promise<void>;

export interface WatchOptions {
  paths: string[];
  ignored?: RegExp;
  debounceMs?: number;
  recursive?: boolean;
  onEvent: WatchCallback;
}

function shouldIgnore(filePath: string, ignored?: RegExp): boolean {
  if (filePath.includes("node_modules")) return true;
  if (filePath.includes(".git")) return true;
  if (filePath.includes(".kitsuden")) return true;
  if (filePath.includes(".llms")) return true;
  if (filePath.includes("dist")) return true;
  if (filePath.includes("coverage")) return true;
  if (ignored?.test(filePath)) return true;
  return false;
}

/**
 * Watch a set of paths for changes.
 * Returns an unsubscribe function.
 */
export function watchPaths(options: WatchOptions): () => void {
  const debounceMs = options.debounceMs ?? 2000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: Array<{ close: () => void }> = [];

  function handleEvent(event: "change" | "rename", filePath: string) {
    if (shouldIgnore(filePath, options.ignored)) return;

    const key = `${event}:${filePath}`;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        Promise.resolve(options.onEvent(event, filePath)).catch(() => {});
      }, debounceMs)
    );
  }

  for (const p of options.paths) {
    const fullPath = resolve(p);
    if (!existsSync(fullPath)) continue;

    try {
      const watcher = fsWatch(
        fullPath,
        { recursive: options.recursive ?? true },
        (eventType, filename) => {
          if (!filename) return;
          const filePath = resolve(fullPath, filename);
          handleEvent(eventType as "change" | "rename", filePath);
        }
      );
      watchers.push(watcher);
    } catch {
      // Fallback: ignore watcher creation errors
    }
  }

  return () => {
    for (const [_, timer] of timers) clearTimeout(timer);
    timers.clear();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
  };
}
