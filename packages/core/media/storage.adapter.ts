/**
 * Storage connection probe for the media kon's settings form
 *
 * Checks that a bucket (MinIO, S3, Cloudflare R2) or a folder answers with the credentials an admin typed
 * in, before they save them. That is all this file does now.
 *
 * It used to hold a second storage implementation as well (`createStorageAdapter` and four adapter
 * classes) that nothing called: files are stored by `apps/api/src/lib/store.ts` and `storage.ts`, which
 * `ctx.storage` uses. Two implementations meant two places where the public/private rule (`private/` keys,
 * `S3_PRIVATE_BUCKET`, signed addresses) could drift apart, and the dead one had none of it: its
 * `getPublicUrl` returned a public address for any key, `private/` included, and it knew nothing of a
 * private bucket. So it was removed; storing goes through the one seam.
 */

// AWS SDK imported lazily to avoid breaking kon loading if packages aren't available
let S3Client: any, HeadBucketCommand: any;

async function loadAwsSdk() {
  if (!S3Client) {
    // @ts-ignore -- OPTIONAL dependency: only needed if the storage
    // is S3. Dynamic import so that whoever uses local disk does not install it.
    const s3 = await import("@aws-sdk/client-s3");
    S3Client = s3.S3Client;
    HeadBucketCommand = s3.HeadBucketCommand;
  }
}

import { existsSync, mkdirSync } from "fs";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";

import { messageOf } from "@kitsuden/engine";

import type { StorageConfig } from "./config.schema";

// ═══════════════════════════════════════════════════════════════════════════
// Test Connection
// ═══════════════════════════════════════════════════════════════════════════

export async function testStorageConnection(
  config: StorageConfig
): Promise<{ success: boolean; message: string }> {
  try {
    switch (config.provider) {
      case "minio":
        return await testMinioConnection(config);
      case "s3":
        return await testS3Connection(config);
      case "local":
        return await testLocalConnection(config);
      case "r2":
        return await testR2Connection(config);
      default:
        return { success: false, message: "Unknown provider" };
    }
  } catch (err: unknown) {
    return { success: false, message: messageOf(err) || "Connection failed" };
  }
}

async function testMinioConnection(
  config: Extract<StorageConfig, { provider: "minio" }>
): Promise<{ success: boolean; message: string }> {
  try {
    await loadAwsSdk();
    const client = new S3Client({
      endpoint: config.endpoint,
      region: "us-east-1", // MinIO doesn't care but SDK requires it
      credentials: {
        accessKeyId: config.accessKey || "",
        secretAccessKey: config.secretKey || "",
      },
      forcePathStyle: true, // Required for MinIO
    });

    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { success: true, message: "Connected to MinIO successfully" };
  } catch (err: unknown) {
    const awsErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (awsErr.name === "NotFound" || awsErr.$metadata?.httpStatusCode === 404) {
      return { success: false, message: `Bucket "${config.bucket}" not found` };
    }
    if (awsErr.name === "Forbidden" || awsErr.$metadata?.httpStatusCode === 403) {
      return { success: false, message: "Invalid credentials" };
    }
    // `code` is set by Node on network errors, not by the AWS SDK.
    if ((err as { code?: string }).code === "ECONNREFUSED") {
      return { success: false, message: `Cannot connect to ${config.endpoint}. Is MinIO running?` };
    }
    return { success: false, message: messageOf(err) || "MinIO connection failed" };
  }
}

async function testS3Connection(
  config: Extract<StorageConfig, { provider: "s3" }>
): Promise<{ success: boolean; message: string }> {
  try {
    await loadAwsSdk();
    const client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId || "",
        secretAccessKey: config.secretAccessKey || "",
      },
    });

    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { success: true, message: "Connected to AWS S3 successfully" };
  } catch (err: unknown) {
    // The AWS SDK puts the HTTP code in `$metadata`, not in the error. It is read
    // with a declared shape instead of `any`: that way it is written down WHICH fields are
    // expected, and if the SDK changes them, this stops compiling instead of starting
    // to return "connection failed" for everything.
    const awsErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = awsErr.$metadata?.httpStatusCode;

    if (awsErr.name === "NotFound" || status === 404) {
      return { success: false, message: `Bucket "${config.bucket}" not found` };
    }
    if (awsErr.name === "Forbidden" || status === 403) {
      return { success: false, message: "Invalid AWS credentials" };
    }
    return { success: false, message: messageOf(err) || "AWS S3 connection failed" };
  }
}

async function testLocalConnection(
  config: Extract<StorageConfig, { provider: "local" }>
): Promise<{ success: boolean; message: string }> {
  try {
    const path = config.path;

    // Check if directory exists or can be created
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }

    // Test write/read/delete
    const testFile = join(path, ".kitsuden-test");
    await writeFile(testFile, "test", "utf-8");
    await readFile(testFile, "utf-8");
    await unlink(testFile);

    return { success: true, message: `Local storage ready at ${path}` };
  } catch (err: unknown) {
    return { success: false, message: `Cannot access ${config.path}: ${messageOf(err)}` };
  }
}

async function testR2Connection(
  config: Extract<StorageConfig, { provider: "r2" }>
): Promise<{ success: boolean; message: string }> {
  try {
    await loadAwsSdk();
    const client = new S3Client({
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      region: "auto",
      credentials: {
        accessKeyId: config.accessKeyId || "",
        secretAccessKey: config.secretAccessKey || "",
      },
    });

    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { success: true, message: "Connected to Cloudflare R2 successfully" };
  } catch (err: unknown) {
    const awsErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (awsErr.name === "NotFound" || awsErr.$metadata?.httpStatusCode === 404) {
      return { success: false, message: `Bucket "${config.bucket}" not found` };
    }
    if (awsErr.name === "Forbidden" || awsErr.$metadata?.httpStatusCode === 403) {
      return { success: false, message: "Invalid R2 credentials" };
    }
    return { success: false, message: messageOf(err) || "R2 connection failed" };
  }
}
