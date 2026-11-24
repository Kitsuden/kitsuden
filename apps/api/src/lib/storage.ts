/**
 * S3 Storage Library
 * Unified storage service for MinIO / S3.
 * Supports upload, delete, signed URLs, and file access.
 */

import { randomUUID } from "crypto";

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { isPrivateKey, s3PublicUrl } from "./store";

// ── Configuration ────────────────────────────────────────────────

// Not exported, and neither is the client: everything goes through the functions below, which pick the
// bucket with `bucketFor`. A raw client plus `BUCKET` in a kon's hands was a way around that choice (a
// `private/` key written to the public bucket); `tests/unit/storage-single-seam.test.ts` keeps it closed.
const REGION = process.env.S3_REGION || "us-east-1";
const ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const BUCKET = process.env.S3_BUCKET || "kitsuden-media";

/**
 * Bucket for `private/…` keys. Empty (the default): one bucket holds everything, and only its policy keeps
 * `private/` from being read unsigned (docs/kons/storage.md).
 *
 * Set, private keys live in a bucket of their own that has no public access at all and is read only through
 * presigned URLs, while `S3_BUCKET` stays the public one (with a custom domain on Cloudflare R2, for
 * example). That is safer than a prefix rule on a shared bucket: a mistake in the rule exposes `private/`,
 * a bucket with no public access has no rule to get wrong. The choice is `isPrivateKey`, the same check that
 * decides when an address must be signed, so a key never lands in one bucket and is looked for in the other.
 */
export const PRIVATE_BUCKET = (process.env.S3_PRIVATE_BUCKET || "").trim();

/** The bucket a key lives in: the private one for `private/…` when `S3_PRIVATE_BUCKET` is set. */
export function bucketFor(s3Key: string): string {
  return PRIVATE_BUCKET && isPrivateKey(s3Key) ? PRIVATE_BUCKET : BUCKET;
}

const DEFAULT_STORAGE_PROVIDER = process.env.DEFAULT_STORAGE_PROVIDER || "local";
const USES_S3_STORAGE = ["s3", "minio"].includes(DEFAULT_STORAGE_PROVIDER);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in your .env file. If you only need local storage, set DEFAULT_STORAGE_PROVIDER=local.`
    );
  }
  return value;
}

let _s3: S3Client | null = null;

/**
 * Lazy S3 client. Credentials are only required when storage provider is s3/minio.
 * No hardcoded secrets. Internal to this module (see `BUCKET` above).
 */
function getS3Client(): S3Client {
  if (!_s3) {
    if (USES_S3_STORAGE) {
      requireEnv("S3_ACCESS_KEY");
      requireEnv("S3_SECRET_KEY");
    }

    _s3 = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || "",
        secretAccessKey: process.env.S3_SECRET_KEY || "",
      },
      forcePathStyle: true,
      // Bounded. Without this the SDK waits without limit (and retries 3 times), and
      // `ctx.storage` is used from routes that run inside an already open
      // Postgres transaction (uploading a document version, deleting a
      // media item): the application role cuts it off after 60 s of waiting.
      // `requestTimeout` is socket inactivity, not duration: a
      // large upload that makes progress is not cut. Worst case: 2 × (5 + 15) s.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 },
      maxAttempts: 2,
    });
  }
  return _s3;
}

// ── Helpers ──────────────────────────────────────────────────────

export function generateS3Key(filename: string, prefix = "public"): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const id = randomUUID().slice(0, 8);
  return `${prefix}/${year}/${month}/${id}-${sanitized}`;
}

/** Same address `publicUrlOf` gives later (honours `S3_PUBLIC_URL_STYLE`). */
function buildPublicUrl(s3Key: string): string {
  return s3PublicUrl(s3Key);
}

function assertS3Enabled(operation: string): void {
  if (!USES_S3_STORAGE) {
    throw new Error(
      `${operation} is only available when DEFAULT_STORAGE_PROVIDER is 's3' or 'minio'. Current: '${DEFAULT_STORAGE_PROVIDER}'`
    );
  }
}

// ── Operations ───────────────────────────────────────────────────

export async function uploadFile(
  file: File | Blob,
  filename: string,
  mimeType: string,
  prefix = "public"
): Promise<{ s3Key: string; url: string; size: number }> {
  assertS3Enabled("uploadFile");
  const s3Key = generateS3Key(filename, prefix);
  const buffer = Buffer.from(await file.arrayBuffer());
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucketFor(s3Key),
      Key: s3Key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
    })
  );

  return {
    s3Key,
    url: buildPublicUrl(s3Key),
    size: buffer.length,
  };
}

/**
 * Upload a raw buffer to S3 (used by image optimization pipeline).
 */
export async function uploadBuffer(
  buffer: Buffer,
  s3Key: string,
  mimeType: string
): Promise<{ s3Key: string; url: string; size: number }> {
  assertS3Enabled("uploadBuffer");
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucketFor(s3Key),
      Key: s3Key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
    })
  );

  return {
    s3Key,
    url: buildPublicUrl(s3Key),
    size: buffer.length,
  };
}

export async function deleteFile(s3Key: string): Promise<void> {
  assertS3Enabled("deleteFile");
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketFor(s3Key),
      Key: s3Key,
    })
  );
}

export async function fileExists(s3Key: string): Promise<boolean> {
  assertS3Enabled("fileExists");
  const client = getS3Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucketFor(s3Key), Key: s3Key }));
    return true;
  } catch {
    return false;
  }
}

export async function getFile(s3Key: string): Promise<ReadableStream | null> {
  assertS3Enabled("getFile");
  const client = getS3Client();
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketFor(s3Key), Key: s3Key })
    );
    return response.Body as unknown as ReadableStream;
  } catch {
    return null;
  }
}

/** The whole object in memory, or `null` if it does not exist. */
export async function getFileBuffer(s3Key: string): Promise<Buffer | null> {
  assertS3Enabled("getFileBuffer");
  const client = getS3Client();
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketFor(s3Key), Key: s3Key })
    );
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

/** Keys of all objects under `prefix` (paginates to the end). */
export async function listKeys(prefix: string): Promise<string[]> {
  assertS3Enabled("listKeys");
  const client = getS3Client();
  // A prefix under `private/` is listed in the private bucket; any other prefix in the public one.
  const bucket = bucketFor(prefix);
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// ── Signed URLs ────────────────────────────────────────────────

/**
 * Generate a time-limited signed URL for secure file access.
 * @param s3Key     The S3 object key
 * @param expiresIn TTL in seconds (default 3600 = 1 hour, max 86400 = 24h)
 */
export async function generateSignedDownloadUrl(s3Key: string, expiresIn = 3600): Promise<string> {
  assertS3Enabled("generateSignedDownloadUrl");
  const clampedExpiry = Math.min(Math.max(expiresIn, 60), 86400);
  const command = new GetObjectCommand({ Bucket: bucketFor(s3Key), Key: s3Key });
  return getSignedUrl(getS3Client(), command, { expiresIn: clampedExpiry });
}
