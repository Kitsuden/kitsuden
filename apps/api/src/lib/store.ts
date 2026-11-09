/**
 * File storage: save, delete and serve
 * ============================================================================
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * Because uploading a file did not work. Ever.
 *
 * The kon loader injected a `ctx.storage` that was a skeleton:
 * `getSignedUploadUrl` returned the empty string and `delete` did nothing. The
 * upload route asked for that URL and did `fetch("")`, so every upload died
 * with
 *
 *     fetch() URL must not be a blank string.
 *
 * and the endpoint responded 207 with `success: false` per file — a "partial
 * success" code that does not catch anyone's attention.
 *
 * The real implementations existed in `packages/core/media/
 * storage.adapter.ts`, but **nobody called `createStorageAdapter`**: complete,
 * tested and disconnected code.
 *
 * ── THE TWO MODES ──────────────────────────────────────────────────────────
 *
 * `DEFAULT_STORAGE_PROVIDER` decides, and by default it is `local`:
 *
 *   · `local`   — container disk, under `uploads/`. Needs nothing else.
 *                 Files are served by the API itself at `/uploads/...`.
 *   · `s3`/`minio` — S3 bucket. Requires `S3_ACCESS_KEY` and `S3_SECRET_KEY`, and
 *                 that the service is up. With docker-compose that
 *                 means enabling the profile: `COMPOSE_PROFILES=s3`.
 *
 * Local mode exists so that an installation works without added
 * infrastructure. It is not suitable for several replicas: each would have its own disk and
 * a file uploaded to one would not be visible from another.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

/**
 * `./storage` is loaded with `await import()`, NOT statically.
 *
 * That module imports the AWS SDK at its top level, and this file is used by
 * the kon loader — so a static import dragged the whole SDK into
 * anything that touched a kon, tests included. It showed up all at once: seven
 * test files started hitting the 60 s hook timeout that used to take
 * seconds.
 *
 * With local disk the SDK is not needed at all, which is exactly what the
 * comment in `storage.adapter.ts` said and had been lost here.
 */
async function s3() {
  return import("./storage");
}

/** Effective provider. It is read once: changing it on the fly would make no sense. */
const PROVIDER = (process.env.DEFAULT_STORAGE_PROVIDER || "local").toLowerCase();

export const usesS3 = ["s3", "minio"].includes(PROVIDER);

/**
 * Base folder of local mode.
 *
 * The variable is called `STORAGE_LOCAL_PATH` because it is the one that was already in
 * `docker-compose.yml`; inventing a new name would have left two.
 *
 * It points to `/app/data` and not to `/app/uploads` to avoid duplicating the prefix: keys
 * already start with `uploads/`, so with base `/app/uploads` files
 * ended up at `/app/uploads/uploads/...`. The prefix is kept
 * because in S3 it is a bucket folder that makes sense.
 *
 * Without `STORAGE_LOCAL_PATH` it falls back to `data/` relative to the working directory, which
 * works for development.
 */
export const LOCAL_DIR = resolve(process.env.STORAGE_LOCAL_PATH || "data");

/**
 * Public base of local mode. It is served by the API itself.
 *
 * It is exported so the route that serves the files is derived from here instead of
 * hard-coding the prefix: if they diverged, the URLs stored in the
 * database would point to a path nobody serves — and those URLs are written into
 * every row, so the failure survives fixing the configuration.
 */
export const BASE_URL_LOCAL = (process.env.STORAGE_LOCAL_URL || "/media").replace(/\/$/, "");
const URL_LOCAL = BASE_URL_LOCAL;

/**
 * Converts a key into a disk path, without allowing escape from the directory.
 *
 * The key comes from a file name uploaded by the user. Without this
 * check, a key with `..` would write wherever it wanted inside the
 * container: `uploads/../../etc/something` is a perfectly valid path for
 * `join`, and the result would have nothing to do with `uploads/`.
 */
export function localPathOf(key: string): string {
  const target = resolve(join(LOCAL_DIR, normalize(key)));

  if (target !== LOCAL_DIR && !target.startsWith(LOCAL_DIR + sep)) {
    throw new Error(`Storage key outside the allowed directory: ${key}`);
  }
  return target;
}

/**
 * How long a file served from `/media` may be cached.
 *
 * Until now, none: they went out without `Cache-Control`, so the browser
 * requested them again on every visit. A grid of a hundred cards meant a hundred full
 * downloads from the API per page view, and a CDN in front would not have helped —
 * without the header it does not know it can keep them either.
 *
 * Only two prefixes are marked `immutable`, because only in them does a key NEVER
 * change content:
 *
 *   · `cartas/` and `juegos/` — the mirror names them by hash of their origin; a new
 *     illustration is a new key.
 *   · `uploads/` — the panel puts the time in front (`uploads/<ms>_<name>`):
 *     replacing an image uploads ANOTHER file, it does not overwrite the previous one.
 *
 * Everything else (the health check, whatever is added without that guarantee) is cached
 * for one hour: long enough to relieve the API and short enough that a change does not take long to
 * show up.
 */
export function mediaCache(key: string): string {
  return /^(cartas|juegos|uploads)\//.test(key)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";
}

export interface SavedObject {
  key: string;
  url: string;
  bytes: number;
}

/**
 * Saves an object and returns where it ended up.
 *
 * Replaces the dance of "request a signed URL and do a PUT", which only makes sense
 * when the client uploads directly to the bucket. Here the file is already in the
 * process: requesting a URL from itself to send it back to itself was an extra round trip
 * that did not even exist in local mode.
 */
export async function saveObject(
  key: string,
  content: Buffer,
  mimeType: string
): Promise<SavedObject> {
  if (usesS3) {
    const { uploadBuffer } = await s3();
    const r = await uploadBuffer(content, key, mimeType);
    return { key: r.s3Key, url: r.url, bytes: r.size };
  }

  const target = localPathOf(key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);

  return {
    key,
    url: `${URL_LOCAL.replace(/\/$/, "")}/${key.replace(/^\/+/, "")}`,
    bytes: content.length,
  };
}

/**
 * Deletes an object. It not existing is NOT an error.
 *
 * Deleting is what happens when a media record is removed, and that operation
 * cannot fail because the file is no longer there: it would leave the row in the database and
 * the user retrying forever.
 */
export async function deleteObject(key: string): Promise<void> {
  if (usesS3) {
    const { deleteFile } = await s3();
    await deleteFile(key);
    return;
  }

  try {
    await unlink(localPathOf(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Reads a whole object. `null` if it does not exist (not an error: whoever asks
 * usually wants to know exactly that, e.g. whether a transformation is already done).
 *
 * It exists because the only way to read was `getSignedDownloadUrl` + `fetch`, and
 * in local mode that URL is a relative path (`/media/...`) that cannot be
 * requested from the server and does not say whether the file exists.
 */
export async function readObject(key: string): Promise<Buffer | null> {
  if (usesS3) {
    const { getFileBuffer } = await s3();
    return getFileBuffer(key);
  }
  try {
    return await readFile(localPathOf(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Keys of all objects that start with `prefix`.
 *
 * In local mode the prefix is treated as a folder (`transforms/<id>/`), which is how
 * the API's keys use it; it is walked entirely and the keys are returned
 * with `/`, just like in S3. A folder that does not exist is an empty list. The
 * prefix goes through `localPathOf`: with `..` it throws instead of listing outside.
 */
export async function listObjects(prefix: string): Promise<string[]> {
  if (usesS3) {
    const { listKeys } = await s3();
    return listKeys(prefix);
  }

  const base = localPathOf(prefix);
  const keys: string[] = [];
  const traverse = async (dir: string): Promise<void> => {
    let inputs;
    try {
      inputs = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of inputs) {
      const route = join(dir, e.name);
      if (e.isDirectory()) await traverse(route);
      else if (e.isFile()) keys.push(relative(LOCAL_DIR, route).split(sep).join("/"));
    }
  };
  await traverse(base);
  return keys.sort();
}

/**
 * Public URL of an already stored object.
 *
 * It is SYNCHRONOUS, so it cannot wait for the lazy import of the SDK: the two
 * constants are read from the environment, which is where `storage.ts` gets them. The
 * default values are repeated on purpose so they match those there.
 */
export function publicUrlOf(key: string): string {
  const cleans = key.replace(/^\/+/, "");
  if (!usesS3) return `${URL_LOCAL}/${cleans}`;

  const publicUrl = (process.env.S3_PUBLIC_URL || "http://localhost:9000").replace(/\/$/, "");
  const bucket = process.env.S3_BUCKET || "kitsuden-media";
  return `${publicUrl}/${bucket}/${cleans}`;
}

export interface StoreStatus {
  provider: string;
  ok: boolean;
  detail: string;
}

/**
 * Checks that storage responds. For the deep healthcheck.
 *
 * Nobody checked it, and that is exactly the failure that slips through: the container
 * declares itself healthy while every upload fails. It writes and deletes a test object,
 * which is the only way to know it really works — a bucket
 * existing does not say whether we can write to it.
 */
export async function checkStorage(): Promise<StoreStatus> {
  const key = "_health/check.txt";
  try {
    await saveObject(key, Buffer.from("ok"), "text/plain");
    await deleteObject(key);
    return {
      provider: PROVIDER,
      ok: true,
      detail: usesS3 ? `bucket ${process.env.S3_BUCKET || "kitsuden-media"}` : LOCAL_DIR,
    };
  } catch (err) {
    return {
      provider: PROVIDER,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * CSP header for everything that comes out of `/media`: no scripts, no
 * forms, in an opaque origin (`sandbox`). Images and videos
 * embedded from the websites are not affected.
 */
export const MEDIA_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
