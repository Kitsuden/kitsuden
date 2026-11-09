import { t } from "$lib/i18n";
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GRIMOIRE CONFIG STORE - Svelte 5 Runes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages the configuration of each grimoire individually.
 * Each grimoire has its own settings section reachable from its UI.
 */

const API_URL = import.meta.env.VITE_API_URL ?? "";

/**
 * Where each grimoire's configuration lives. The media one is at
 * `/api/media/config` (packages/core/media/media.routes.ts); `/api/grimoires/:id/config`
 * does not exist in the API, so the Media "Settings" tab always loaded the
 * default values and SAVING failed with a 404.
 */
function configPath(grimoireId: string): string {
  if (grimoireId === "grimoire-media" || grimoireId === "kon-media")
    return `${API_URL}/api/media/config`;
  return `${API_URL}/api/grimoires/${grimoireId}/config`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

export type StorageProvider = "minio" | "s3" | "local" | "r2";

export interface MinioStorageConfig {
  provider: "minio";
  endpoint: string;
  bucket: string;
  accessKey?: string;
  secretKey?: string;
  publicUrl?: string;
  useSSL?: boolean;
}

export interface S3StorageConfig {
  provider: "s3";
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicUrl?: string;
}

export interface LocalStorageConfig {
  provider: "local";
  path: string;
  publicUrl: string;
}

export interface R2StorageConfig {
  provider: "r2";
  accountId: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicUrl?: string;
}

export type StorageConfig =
  | MinioStorageConfig
  | S3StorageConfig
  | LocalStorageConfig
  | R2StorageConfig;

export interface MediaFeaturesConfig {
  thumbnails: boolean;
  imageOptimization: boolean;
  signedUrls: boolean;
  maxFileSize: number; // in MB
  allowedTypes: string[];
}

export interface MediaGrimoireConfig {
  storage: StorageConfig;
  features: MediaFeaturesConfig;
  [key: string]: unknown;
}

// Generic config for any grimoire
export interface GrimoireConfig {
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// GrimoireConfigStore
// ═══════════════════════════════════════════════════════════════════════════

export class GrimoireConfigStore {
  // ─── Core State ───
  configs = $state<Record<string, GrimoireConfig>>({});
  isLoading = $state<Record<string, boolean>>({});
  isSaving = $state<Record<string, boolean>>({});
  errors = $state<Record<string, string | null>>({});
  saveSuccess = $state<Record<string, boolean>>({});

  // ═══════════════════════════════════════════════════════════════════════════
  // CRUD methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Loads a grimoire's configuration
   */
  async loadConfig(grimoireId: string): Promise<GrimoireConfig | null> {
    this.isLoading[grimoireId] = true;
    this.errors[grimoireId] = null;

    try {
      const response = await fetch(`${configPath(grimoireId)}`, {
        credentials: "include",
      });

      if (!response.ok) {
        // 404 = no config yet, return default
        if (response.status === 404) {
          const defaultConfig = this.getDefaultConfig(grimoireId);
          this.configs[grimoireId] = defaultConfig;
          return defaultConfig;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      this.configs[grimoireId] = data.config;
      return data.config;
    } catch (err) {
      this.errors[grimoireId] =
        err instanceof Error ? err.message : t("grimoireConfig.couldNotLoad");
      console.error(`[GrimoireConfigStore] loadConfig(${grimoireId}) error:`, err);
      return null;
    } finally {
      this.isLoading[grimoireId] = false;
    }
  }

  /**
   * Saves a grimoire's configuration
   */
  async saveConfig(grimoireId: string, config: GrimoireConfig): Promise<boolean> {
    this.isSaving[grimoireId] = true;
    this.errors[grimoireId] = null;
    this.saveSuccess[grimoireId] = false;

    try {
      const response = await fetch(`${configPath(grimoireId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ config }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      this.configs[grimoireId] = config;
      this.saveSuccess[grimoireId] = true;

      // Clear success after 3 seconds
      setTimeout(() => {
        this.saveSuccess[grimoireId] = false;
      }, 3000);

      return true;
    } catch (err) {
      this.errors[grimoireId] =
        err instanceof Error ? err.message : t("grimoireConfig.couldNotSave");
      console.error(`[GrimoireConfigStore] saveConfig(${grimoireId}) error:`, err);
      return false;
    } finally {
      this.isSaving[grimoireId] = false;
    }
  }

  /**
   * Tests the storage connection
   */
  async testStorageConnection(
    grimoireId: string,
    storageConfig: StorageConfig
  ): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`${configPath(grimoireId)}/test-storage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ storage: storageConfig }),
      });

      const data = await response.json();
      return {
        success: response.ok && data.success,
        message: data.message || data.error || t("grimoireConfig.unknownResult"),
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : t("grimoireConfig.failedConnectionTest"),
      };
    }
  }

  /**
   * Resets the configuration to defaults
   */
  async resetConfig(grimoireId: string): Promise<boolean> {
    const defaultConfig = this.getDefaultConfig(grimoireId);
    return this.saveConfig(grimoireId, defaultConfig);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Getters
  // ═══════════════════════════════════════════════════════════════════════════

  getConfig(grimoireId: string): GrimoireConfig | null {
    return this.configs[grimoireId] || null;
  }

  isConfigLoading(grimoireId: string): boolean {
    return this.isLoading[grimoireId] || false;
  }

  isConfigSaving(grimoireId: string): boolean {
    return this.isSaving[grimoireId] || false;
  }

  getConfigError(grimoireId: string): string | null {
    return this.errors[grimoireId] || null;
  }

  getConfigSaveSuccess(grimoireId: string): boolean {
    return this.saveSuccess[grimoireId] || false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Defaults
  // ═══════════════════════════════════════════════════════════════════════════

  getDefaultConfig(grimoireId: string): GrimoireConfig {
    switch (grimoireId) {
      case "grimoire-media":
        return this.getDefaultMediaConfig();
      default:
        return {};
    }
  }

  getDefaultMediaConfig(): MediaGrimoireConfig {
    return {
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  getStorageProviderLabel(provider: StorageProvider): string {
    const labels: Record<StorageProvider, string> = {
      minio: t("grimoireConfig.minio"),
      s3: "AWS S3",
      local: t("grimoireConfig.local"),
      r2: "Cloudflare R2",
    };
    return labels[provider] || provider;
  }

  getStorageProviderDescription(provider: StorageProvider): string {
    const descriptions: Record<StorageProvider, string> = {
      minio: t("grimoireConfig.minioDescription"),
      s3: t("grimoireConfig.s3Description"),
      local: t("grimoireConfig.localDescription"),
      r2: t("grimoireConfig.r2Description"),
    };
    return descriptions[provider] || "";
  }

  clearError(grimoireId: string): void {
    this.errors[grimoireId] = null;
  }

  clearSuccess(grimoireId: string): void {
    this.saveSuccess[grimoireId] = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton instance
// ═══════════════════════════════════════════════════════════════════════════

export const grimoireConfigStore = new GrimoireConfigStore();

// Type exports - GrimoireConfig already exported as interface
