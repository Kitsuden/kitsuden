/**
 * Kitsuden — Read files the same under Bun and Node 22+
 * ============================================================================
 *
 * The API used `Bun.file()` in about twenty places, and that tied it to Bun:
 * under Node, the first access threw `Bun is not defined`. `file()` gives the
 * same shape (what was used: `exists`, `text`, `json`, `lastModified`):
 * under Bun it IS `Bun.file` (fast, zero-copy); under Node, `node:fs`.
 *
 * To serve a file as the body of a `Response`, `fileBody()`:
 * under Bun the `BunFile` (Bun sets the type and sends it without copying); under Node a
 * `ReadableStream` and the type by extension.
 */

import { createReadStream, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";

export interface File {
  exists(): Promise<boolean>;
  text(): Promise<string>;
  // `any` like `BunFile.json()`: the caller already treated the result that way.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json<T = any>(): Promise<T>;
  /** Milliseconds since 1970 (0 if it does not exist). */
  readonly lastModified: number;
}

type ResponseBody = ConstructorParameters<typeof Response>[0];

const BunGlobal = (globalThis as { Bun?: { file(route: string): unknown } }).Bun;

export function file(route: string): File {
  if (BunGlobal) return BunGlobal.file(route) as File;
  return {
    async exists() {
      try {
        return (await stat(route)).isFile();
      } catch {
        return false;
      }
    },
    text: () => readFile(route, "utf8"),
    async json<T>() {
      return JSON.parse(await readFile(route, "utf8")) as T;
    },
    get lastModified() {
      try {
        return statSync(route).mtimeMs;
      } catch {
        return 0;
      }
    },
  };
}

const TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** The body for `new Response(...)` and, under Node, the type (Bun sets it by itself). */
export function fileBody(route: string): { body: ResponseBody; type: string | null } {
  if (BunGlobal) return { body: BunGlobal.file(route) as ResponseBody, type: null };
  return {
    body: Readable.toWeb(createReadStream(route)) as unknown as ResponseBody,
    type: TYPES[extname(route).toLowerCase()] ?? "application/octet-stream",
  };
}
