import { t } from "$lib/i18n";
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GLOBAL REACTIVE STATE - Media Library (Svelte 5 Runes)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Global state for media files using the Svelte 5 reactivity system.
 *
 * ⚠️ IMPORTANT: Do not use old stores (writable, readable, derived).
 * Svelte 5 Runes provides fine-grained reactivity without boilerplate.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface MediaFile {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  key: string;
  bucket: string;
  publicUrl: string | null;
  url?: string; // Signed URL
  thumbnails?: Record<string, { url: string; width: number; height: number }>;
  width?: number;
  height?: number;
  folderId?: string | null;
  altText?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdById?: string;
}

export interface MediaFolder {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
  path: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadProgress {
  filename: string;
  progress: number;
  status: "pending" | "uploading" | "success" | "error";
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const API_URL = import.meta.env.VITE_API_URL ?? "";

/**
 * With local storage the API returns paths like `/media/uploads/x.png`, which
 * IT serves. If the panel lives on another origin (VITE_API_URL), that relative path
 * requested the file from the panel server: 404 and a broken thumbnail. It is resolved against
 * the API; absolute URLs (S3, R2, CDN) are left alone.
 */
export function mediaUrl(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") && API_URL ? API_URL + url : url;
}

// ═══════════════════════════════════════════════════════════════════════════
// MediaStore - Global Reactive State
// ═══════════════════════════════════════════════════════════════════════════

export class MediaStore {
  // ─── Core State ───
  files = $state<MediaFile[]>([]);
  folders = $state<MediaFolder[]>([]);
  isLoading = $state<boolean>(false);
  isUploading = $state<boolean>(false);
  selectedFile = $state<MediaFile | null>(null);
  selectedFolder = $state<MediaFolder | null>(null);
  error = $state<string | null>(null);
  searchQuery = $state<string>("");
  filterType = $state<string>(""); // "image", "video", "document", ""
  viewMode = $state<"grid" | "list">("grid");
  uploadProgress = $state<UploadProgress[]>([]);

  // ─── Derived State ───
  totalCount = $derived<number>(this.files.length);
  filteredFiles = $derived<MediaFile[]>(this.getFilteredFiles());

  private getFilteredFiles(): MediaFile[] {
    let result = this.files;

    // Filter by folder
    if (this.selectedFolder) {
      result = result.filter((f) => f.folderId === this.selectedFolder!.id);
    } else {
      result = result.filter((f) => !f.folderId);
    }

    // Filter by search query
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(
        (f) => f.filename.toLowerCase().includes(q) || f.originalName.toLowerCase().includes(q)
      );
    }

    // Filter by type
    if (this.filterType) {
      result = result.filter((f) => f.mimeType.startsWith(`${this.filterType}/`));
    }

    return result;
  }

  imageFiles = $derived<MediaFile[]>(this.files.filter((f) => f.mimeType.startsWith("image/")));
  videoFiles = $derived<MediaFile[]>(this.files.filter((f) => f.mimeType.startsWith("video/")));
  documentFiles = $derived<MediaFile[]>(
    this.files.filter(
      (f) => f.mimeType.includes("pdf") || f.mimeType.includes("doc") || f.mimeType.includes("text")
    )
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CRUD methods - Files
  // ═══════════════════════════════════════════════════════════════════════════

  async fetchFiles(folderId?: string, search?: string): Promise<void> {
    this.isLoading = true;
    this.error = null;

    try {
      const params = new URLSearchParams();
      if (folderId) params.set("folderId", folderId);
      if (search) params.set("search", search);
      params.set("limit", "100");

      const response = await fetch(`${API_URL}/api/media?${params}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      this.files = data.docs || [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.couldNotLoadFiles");
      console.error("[MediaStore] fetchFiles error:", err);
    } finally {
      this.isLoading = false;
    }
  }

  async fetchFileById(id: string): Promise<MediaFile | null> {
    try {
      const response = await fetch(`${API_URL}/api/media/${id}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const file: MediaFile = await response.json();
      this.selectedFile = file;
      return file;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.couldNotLoadFile", { id });
      return null;
    }
  }

  async uploadFiles(files: FileList | File[], folderId?: string): Promise<boolean> {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return false;

    this.isUploading = true;
    this.uploadProgress = fileArray.map((f) => ({
      filename: f.name,
      progress: 0,
      status: "pending" as const,
    }));

    try {
      const formData = new FormData();
      fileArray.forEach((file) => formData.append("files", file));

      const params = new URLSearchParams();
      if (folderId) params.set("folderId", folderId);

      const response = await fetch(`${API_URL}/api/media/upload?${params}`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();

      // Update progress
      this.uploadProgress = this.uploadProgress.map((p) => ({
        ...p,
        progress: 100,
        status: "success",
      }));

      // Refresh file list
      await this.fetchFiles(folderId);

      return result.success;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.uploadFailed");
      this.uploadProgress = this.uploadProgress.map((p) => ({
        ...p,
        status: "error",
        error: this.error || t("mediaStore.uploadFailed"),
      }));
      return false;
    } finally {
      this.isUploading = false;
      // Clear progress after a delay
      setTimeout(() => {
        this.uploadProgress = [];
      }, 3000);
    }
  }

  async updateFile(id: string, updates: Partial<MediaFile>): Promise<MediaFile | null> {
    try {
      const response = await fetch(`${API_URL}/api/media/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const updated: MediaFile = await response.json();
      this.files = this.files.map((f) => (f.id === id ? updated : f));
      if (this.selectedFile?.id === id) {
        this.selectedFile = updated;
      }
      return updated;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.couldNotUpdate");
      return null;
    }
  }

  async deleteFile(id: string): Promise<boolean> {
    if (!confirm(t("mediaStore.confirmDelete"))) return false;

    try {
      const response = await fetch(`${API_URL}/api/media/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.files = this.files.filter((f) => f.id !== id);
      if (this.selectedFile?.id === id) {
        this.selectedFile = null;
      }
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.couldNotRemove");
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CRUD methods - Folders
  // ═══════════════════════════════════════════════════════════════════════════

  async fetchFolders(): Promise<void> {
    try {
      const response = await fetch(`${API_URL}/api/media/folders`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      this.folders = data.docs || [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.couldNotLoadDirs");
    }
  }

  async createFolder(name: string, parentId?: string): Promise<MediaFolder | null> {
    try {
      const parent = parentId ? this.folders.find((f) => f.id === parentId) : null;

      const response = await fetch(`${API_URL}/api/media/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name,
          parentId,
          parentPath: parent?.path,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const newFolder: MediaFolder = await response.json();
      this.folders = [...this.folders, newFolder];
      return newFolder;
    } catch (err) {
      this.error = err instanceof Error ? err.message : t("mediaStore.couldNotCreateDir");
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI State methods
  // ═══════════════════════════════════════════════════════════════════════════

  selectFile(file: MediaFile | null): void {
    this.selectedFile = file;
  }

  selectFolder(folder: MediaFolder | null): void {
    this.selectedFolder = folder;
    this.fetchFiles(folder?.id);
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
  }

  setFilterType(type: string): void {
    this.filterType = type;
  }

  setViewMode(mode: "grid" | "list"): void {
    this.viewMode = mode;
  }

  clearError(): void {
    this.error = null;
  }

  reset(): void {
    this.files = [];
    this.folders = [];
    this.selectedFile = null;
    this.selectedFolder = null;
    this.error = null;
    this.searchQuery = "";
    this.filterType = "";
    this.isLoading = false;
    this.isUploading = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  getFileUrl(file: MediaFile, size?: "small" | "medium" | "large"): string {
    if (size && file.thumbnails?.[size]) {
      return mediaUrl(file.thumbnails[size].url);
    }
    return mediaUrl(file.url || file.publicUrl || "");
  }

  getFileIcon(mimeType: string): string {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType.startsWith("video/")) return "🎬";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("doc")) return "📝";
    return "📎";
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton instance
// ═══════════════════════════════════════════════════════════════════════════

export const mediaStore = new MediaStore();
