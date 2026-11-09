/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTOSAVE REACTIVE STATE - Svelte 5 Runes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages temporary versions of forms in localStorage.
 * Pattern: Reactive Class with $state + Singleton Instance
 */

export type AutosaveStatus = "idle" | "saving" | "saved" | "unsaved";

export interface AutosaveVersion {
  timestamp: number;
  data: Record<string, any>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEY_PREFIX = "kitsuden_autosave_";
const MAX_VERSIONS = 5;
const AUTOSAVE_INTERVAL_MS = 10000;

// ═══════════════════════════════════════════════════════════════════════════
// AutosaveStore class
// ═══════════════════════════════════════════════════════════════════════════

export class AutosaveStore {
  // ─── Core Reactive State ───
  status = $state<AutosaveStatus>("idle");
  currentKey = $state<string | null>(null);
  versions = $state<AutosaveVersion[]>([]);
  restoredData = $state<Record<string, any> | null>(null);

  // ─── Internal State ───
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastSavedSnapshot: string = "";
  private pendingData: Record<string, any> = {};

  // ─── Lifecycle ───

  /**
   * Starts autosave for a specific key.
   * @param key Unique identifier (e.g. `tablename_entryId` or `tablename_new`)
   * @param initialData Initial form data
   */
  startAutosave(key: string, initialData: Record<string, any>) {
    this.stopAutosave();
    this.currentKey = key;
    this.pendingData = JSON.parse(JSON.stringify(initialData));
    this.lastSavedSnapshot = JSON.stringify(initialData);
    this.status = "saved";
    this.versions = this.loadVersions(key);

    this.intervalId = setInterval(() => {
      this.performAutosave();
    }, AUTOSAVE_INTERVAL_MS);
  }

  /**
   * Stops the autosave interval and clears the current key.
   */
  stopAutosave() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.currentKey = null;
    this.status = "idle";
    this.versions = [];
    this.restoredData = null;
  }

  /**
   * Updates the pending data and marks it as "unsaved" if it changed.
   */
  updateData(data: Record<string, any>) {
    this.pendingData = JSON.parse(JSON.stringify(data));
    const snapshot = JSON.stringify(this.pendingData);
    if (snapshot !== this.lastSavedSnapshot && this.status !== "saving") {
      this.status = "unsaved";
    }
  }

  /**
   * Forces the state to "unsaved".
   */
  markDirty() {
    if (this.status !== "saving") {
      this.status = "unsaved";
    }
  }

  /**
   * Saved versions of a key, WITHOUT starting autosave.
   *
   * It is needed so we can check whether there is an earlier draft before deciding
   * what to do with it. `startAutosave` also loads them, but along the way it starts
   * the clock and sets the reference snapshot: using it to look things up
   * would force starting before knowing whether there is anything to recover, and the first
   * write of the interval would overwrite the draft we wanted to read.
   */
  savedVersions(key: string): AutosaveVersion[] {
    return this.loadVersions(key);
  }

  // ─── Version operations ───

  /**
   * Restores a previous version by index.
   * Updates `restoredData` so components can sync.
   */
  restoreVersion(index: number): boolean {
    const version = this.versions[index];
    if (!version) return false;

    this.pendingData = JSON.parse(JSON.stringify(version.data));
    this.lastSavedSnapshot = JSON.stringify(version.data);
    this.status = "saved";
    this.restoredData = JSON.parse(JSON.stringify(version.data));
    return true;
  }

  /**
   * Deletes all the versions of a key (or of the current key).
   */
  deleteAllVersions(key?: string) {
    const targetKey = key || this.currentKey;
    if (!targetKey) return;

    try {
      localStorage.removeItem(this.getStorageKey(targetKey));
    } catch {
      // Safari private mode can fail
    }

    if (targetKey === this.currentKey) {
      this.versions = [];
      this.lastSavedSnapshot = "";
      this.status = "unsaved";
    }
  }

  /**
   * Clears the current autosave and stops the interval.
   */
  clearCurrentAutosave() {
    if (this.currentKey) {
      this.deleteAllVersions(this.currentKey);
    }
    this.stopAutosave();
  }

  // ─── Persistence in localStorage ───

  private getStorageKey(key: string): string {
    return `${STORAGE_KEY_PREFIX}${key}`;
  }

  private loadVersions(key: string): AutosaveVersion[] {
    try {
      const raw = localStorage.getItem(this.getStorageKey(key));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignore localStorage errors
    }
    return [];
  }

  private saveVersions(key: string, versions: AutosaveVersion[]) {
    try {
      localStorage.setItem(this.getStorageKey(key), JSON.stringify(versions));
    } catch {
      // Safari private mode can fail
    }
  }

  private performAutosave() {
    if (!this.currentKey || this.status === "saving") return;

    const snapshot = JSON.stringify(this.pendingData);
    if (snapshot === this.lastSavedSnapshot) return;

    this.status = "saving";

    const version: AutosaveVersion = {
      timestamp: Date.now(),
      data: JSON.parse(snapshot),
    };

    const newVersions = [version, ...this.versions].slice(0, MAX_VERSIONS);
    this.versions = newVersions;
    this.saveVersions(this.currentKey, newVersions);
    this.lastSavedSnapshot = snapshot;

    // Short delay to show the "saving" state
    setTimeout(() => {
      this.status = "saved";
    }, 400);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton instance
// ═══════════════════════════════════════════════════════════════════════════

export const autosaveStore = new AutosaveStore();
