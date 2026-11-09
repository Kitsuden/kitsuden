/**
 * Media Kon Configuration Schema
 *
 * Defines and validates the Media Library configuration.
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Storage Config Schemas
// ═══════════════════════════════════════════════════════════════════════════

export const minioStorageSchema = z.object({
  provider: z.literal("minio"),
  endpoint: z.string().url().default("http://localhost:9000"),
  bucket: z.string().min(1).default("kitsuden-media"),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
  publicUrl: z.string().url().optional(),
  useSSL: z.boolean().default(false),
});

export const s3StorageSchema = z.object({
  provider: z.literal("s3"),
  region: z.string().min(1).default("us-east-1"),
  bucket: z.string().min(1),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  publicUrl: z.string().url().optional(),
});

export const localStorageSchema = z.object({
  provider: z.literal("local"),
  path: z.string().min(1).default("./uploads"),
  publicUrl: z.string().url().default("http://localhost:3001/uploads"),
});

export const r2StorageSchema = z.object({
  provider: z.literal("r2"),
  accountId: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  publicUrl: z.string().url().optional(),
});

export const storageConfigSchema = z.discriminatedUnion("provider", [
  minioStorageSchema,
  s3StorageSchema,
  localStorageSchema,
  r2StorageSchema,
]);

// ═══════════════════════════════════════════════════════════════════════════
// Features Config Schema
// ═══════════════════════════════════════════════════════════════════════════

export const mediaFeaturesSchema = z.object({
  thumbnails: z.boolean().default(true),
  imageOptimization: z.boolean().default(true),
  signedUrls: z.boolean().default(true),
  maxFileSize: z.number().min(1).max(100).default(10), // MB
  allowedTypes: z.array(z.string()).default(["image/*", "video/*", "application/pdf"]),
});

// ═══════════════════════════════════════════════════════════════════════════
// Complete Media Config Schema
// ═══════════════════════════════════════════════════════════════════════════

export const mediaKonConfigSchema = z.object({
  storage: storageConfigSchema,
  features: mediaFeaturesSchema,
});

// ═══════════════════════════════════════════════════════════════════════════
// TypeScript types
// ═══════════════════════════════════════════════════════════════════════════

export type MinioStorageConfig = z.infer<typeof minioStorageSchema>;
export type S3StorageConfig = z.infer<typeof s3StorageSchema>;
export type LocalStorageConfig = z.infer<typeof localStorageSchema>;
export type R2StorageConfig = z.infer<typeof r2StorageSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type MediaFeaturesConfig = z.infer<typeof mediaFeaturesSchema>;
export type MediaKonConfig = z.infer<typeof mediaKonConfigSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Default Configuration
// ═══════════════════════════════════════════════════════════════════════════

export const defaultMediaConfig: MediaKonConfig = {
  storage: {
    provider: "minio",
    endpoint: "http://localhost:9000",
    bucket: "kitsuden-media",
    useSSL: false,
    publicUrl: "http://localhost:9000/kitsuden-media",
  },
  features: {
    thumbnails: true,
    imageOptimization: true,
    signedUrls: true,
    maxFileSize: 10,
    allowedTypes: ["image/*", "video/*", "application/pdf"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Validation Helper
// ═══════════════════════════════════════════════════════════════════════════

export function validateMediaConfig(
  config: unknown
): { valid: true; data: MediaKonConfig } | { valid: false; error: string } {
  const result = mediaKonConfigSchema.safeParse(config);

  if (result.success) {
    return { valid: true, data: result.data };
  } else {
    const errors = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
    return { valid: false, error: errors.join(", ") };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider Info
// ═══════════════════════════════════════════════════════════════════════════

export const storageProviders = [
  {
    id: "minio" as const,
    label: "MinIO (Self-hosted S3)",
    description:
      "Self-hosted S3-compatible storage. Good for local development and on-premise deployments.",
    icon: "Server",
    fields: [
      { key: "endpoint", label: "Endpoint URL", type: "url", placeholder: "http://localhost:9000" },
      { key: "bucket", label: "Bucket Name", type: "text", placeholder: "kitsuden-media" },
      { key: "accessKey", label: "Access Key", type: "text", placeholder: "kitsuden_minio" },
      { key: "secretKey", label: "Secret Key", type: "password", placeholder: "••••••••" },
      {
        key: "publicUrl",
        label: "Public URL (optional)",
        type: "url",
        placeholder: "http://localhost:9000/kitsuden-media",
      },
      { key: "useSSL", label: "Use SSL", type: "checkbox" },
    ],
  },
  {
    id: "s3" as const,
    label: "AWS S3",
    description: "Amazon Web Services S3. Enterprise-grade cloud storage.",
    icon: "Cloud",
    fields: [
      { key: "region", label: "Region", type: "text", placeholder: "us-east-1" },
      { key: "bucket", label: "Bucket Name", type: "text", placeholder: "my-bucket" },
      { key: "accessKeyId", label: "Access Key ID", type: "text", placeholder: "AKIA..." },
      {
        key: "secretAccessKey",
        label: "Secret Access Key",
        type: "password",
        placeholder: "••••••••",
      },
      {
        key: "publicUrl",
        label: "Custom Domain (optional)",
        type: "url",
        placeholder: "https://cdn.example.com",
      },
    ],
  },
  {
    id: "local" as const,
    label: "Local Filesystem",
    description: "Store files on local filesystem. Simple but not scalable. Good for development.",
    icon: "HardDrive",
    fields: [
      { key: "path", label: "Storage Path", type: "text", placeholder: "./uploads" },
      {
        key: "publicUrl",
        label: "Public URL",
        type: "url",
        placeholder: "http://localhost:3001/uploads",
      },
    ],
  },
  {
    id: "r2" as const,
    label: "Cloudflare R2",
    description: "Cloudflare R2. S3-compatible with zero egress fees.",
    icon: "Cloud",
    fields: [
      { key: "accountId", label: "Account ID", type: "text", placeholder: "abc123..." },
      { key: "bucket", label: "Bucket Name", type: "text", placeholder: "my-bucket" },
      { key: "accessKeyId", label: "Access Key ID", type: "text", placeholder: "..." },
      {
        key: "secretAccessKey",
        label: "Secret Access Key",
        type: "password",
        placeholder: "••••••••",
      },
      {
        key: "publicUrl",
        label: "Public URL (optional)",
        type: "url",
        placeholder: "https://pub-...r2.dev",
      },
    ],
  },
];
