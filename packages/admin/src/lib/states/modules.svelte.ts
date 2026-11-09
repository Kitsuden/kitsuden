import { t } from "$lib/i18n";
/**
 * Shared Module State (Svelte 5 Runes)
 *
 * Single source of truth for which kons/modules are enabled.
 * Used by both SidebarLayout (for nav filtering) and Kons view (for toggling).
 * When a kon is toggled in the Kons view, the sidebar updates instantly.
 */

const API_URL = import.meta.env.VITE_API_URL ?? "";

export interface ModuleInfo {
  key: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  icon?: string;
  color?: string;
  canToggle?: boolean;
  isGrimoireActive?: boolean;
  grimoireId?: string;
  source?: string;
  tables?: string[];
  dependsOn?: string[];
  enabledByGrimoire?: boolean;
  sidebarBadge?: string;
  /** Maturity declared in kon.json. */
  maturity?: "stable" | "beta" | "experimental";
}

export interface UninstalledKon {
  key: string;
  name: string;
  status: "uninstalled";
  hasPreservedData: boolean;
  dataSummary: {
    totalRows: number;
    tables: Array<{ name: string; rows: number }>;
  };
  canRecover: boolean;
  canDelete: boolean;
  actions: string[];
}

export interface ModulesResponse {
  activeGrimoire?: string;
  categories: {
    core?: { modules: ModuleInfo[] };
    "grimoire-core"?: { modules: ModuleInfo[] };
    optional?: { modules: ModuleInfo[] };
    grimoire?: { modules: ModuleInfo[] };
    uninstalled?: {
      label: string;
      description: string;
      modules: UninstalledKon[];
    };
  };
  docs: ModuleInfo[];
}

class ModuleStore {
  modules = $state<ModuleInfo[]>([]);
  uninstalled = $state<UninstalledKon[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  activeGrimoire = $state<string | null>(null);

  /**
   * Pending notice of "restart the API to finish activating this kon".
   *
   * It lives in the store and not in the toggle component because the user
   * usually activates the kon and navigates away; the notice has to survive that change
   * of screen or nobody reads it. It is cleared when they close it.
   */
  restartWarning = $state<string | null>(null);

  /**
   * Set of enabled module keys — derived reactively.
   * SidebarLayout uses this to filter nav items.
   */
  enabledKeys = $derived(new Set(this.modules.filter((m) => m.enabled).map((m) => m.key)));

  /**
   * The same, but identifying the KON and not the string.
   *
   * `kon-games` and `games` are the same kon: the database holds both rows with
   * and without the prefix, inherited from before the convention. The sidebar
   * compared the exact key, so a menu entry declared as
   * `blog` was not shown even if what was enabled was `kon-blog` — and vice versa.
   */
  activeKonKeys = $derived(new Set([...this.enabledKeys].map((k) => k.replace(/^kon-/, ""))));

  /**
   * Is this kon enabled, whatever form the key comes in?
   *
   * It is what any navigation filter should use: a disabled kon —or one
   * that no longer exists, which does not appear in `modules` either— cannot
   * leave its link in the menu.
   */
  activeKon(key: string): boolean {
    return this.activeKonKeys.has(key.replace(/^kon-/, ""));
  }

  /**
   * Each call to `fetchModules` carries a number. If, while one waits to
   * retry, another arrives (the "Retry" button, or Kons reloading after
   * activating something), the old one stops writing: otherwise its late error would overwrite the
   * good list the new one just fetched.
   */
  #request = 0;

  /**
   * Fetches the modules from the API, retrying transient failures.
   *
   * It used to be a single attempt: if `/api/modules` failed at startup (the API
   * restarting after activating a kon, a network cut) the menu stayed on
   * "Dashboard" until the whole page was reloaded, without saying why.
   *
   * It retries what can fix itself —network error, 5xx, 408, 429—
   * with growing waits (`wait`, `2·wait`, …) and up to `attempts` times in
   * total. A 401/403 is not retried: the session is not going to change by waiting.
   * If it still fails in the end, `error` stays set and the sidebar offers
   * a button to try again.
   */
  async fetchModules({ attempts = 3, wait = 500 }: { attempts?: number; wait?: number } = {}) {
    const thisRequest = ++this.#request;
    const current = () => thisRequest === this.#request;

    // `error` is NOT cleared here: if it is retrying after a failure, the notice
    // stays visible (with "Retrying…") instead of disappearing and coming back.
    // It is cleared only when the list arrives.
    this.loading = true;
    try {
      for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
        let transient = false;
        let failure: string;
        try {
          const res = await fetch(`${API_URL}/api/modules`, { credentials: "include" });
          if (!current()) return;
          if (res.ok) {
            const data: ModulesResponse = await res.json();
            if (!current()) return;
            this.activeGrimoire = data.activeGrimoire || null;
            this.modules = data.docs || [];
            this.uninstalled = data.categories?.uninstalled?.modules || [];
            this.error = null;
            return;
          }
          transient = res.status >= 500 || res.status === 408 || res.status === 429;
          failure = t("modulesStore.couldNotLoad");
        } catch {
          if (!current()) return;
          transient = true;
          failure = t("modulesStore.networkError");
        }

        if (!transient || attempt >= attempts) {
          this.error = failure;
          return;
        }
        await new Promise((r) => setTimeout(r, wait * 2 ** (attempt - 1)));
        if (!current()) return;
      }
    } finally {
      if (current()) this.loading = false;
    }
  }

  /**
   * Toggle a module's enabled state and update the API.
   * Returns true if successful.
   */
  async toggleModule(key: string): Promise<boolean> {
    const mod = this.modules.find((m) => m.key === key);
    if (!mod || mod.canToggle === false) return false;

    const newEnabled = !mod.enabled;
    try {
      const res = await fetch(`${API_URL}/api/modules/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: newEnabled }),
      });

      if (res.ok) {
        // Update local state immediately — sidebar reacts instantly
        this.modules = this.modules.map((m) => (m.key === key ? { ...m, enabled: newEnabled } : m));

        /**
         * The kon may be left half-done, and that has to be said.
         *
         * Its tables are created on the fly, but the API routes are mounted at
         * startup: Hono does not allow `app.route()` after the first
         * request. Without this notice the kon shows up in the menu and each of its
         * screens returns 404 with no explanation — which is exactly the state that
         * had to be debugged for an entire session.
         */
        const data = (await res.json().catch(() => ({}))) as {
          requiresRestart?: boolean;
          mountedNow?: boolean;
          restartReason?: string;
        };

        /**
         * The normal case is that the kon ends up serving IMMEDIATELY: the API
         * reserves the route of each disabled kon during startup and only
         * hangs the router on it when it is activated (see `lib/deferred-kons.ts`).
         *
         * `requiresRestart` appears only when that could not be done —a
         * kon whose route was not reserved, or whose code did not load—. Warning is
         * what keeps the user from discovering the 404 screen by screen.
         */
        if (data.requiresRestart) {
          this.restartWarning = data.restartReason ?? t("modulesStore.restartsApi");
        }
        return true;
      } else {
        const err = await res.json().catch(() => ({}));

        /**
         * The 409 that refuses to activate a broken kon carries THREE pieces and all three
         * are needed: what is happening, which tables are missing and what to do.
         *
         * Showing only `message` left the user with "tables missing" and no
         * way out — and in the most common case the way out is a line of SQL that
         * comes in `hint`. Without it you have to go to the container logs
         * to learn something the API already knew.
         */
        const parts = [err.message || err.error || t("modulesStore.couldNotChange")];
        if (Array.isArray(err.missingTables) && err.missingTables.length > 0) {
          parts.push(t("modulesStore.missingTables", { tables: err.missingTables.join(", ") }));
        }
        if (err.hint) parts.push(err.hint);
        alert(parts.join("\n\n"));
        return false;
      }
    } catch {
      alert(t("modulesStore.networkErrorOnChange"));
      return false;
    }
  }

  /**
   * Uninstall a kon but preserve its data.
   * The kon will move to "Uninstalled (Data Preserved)" section.
   */
  async uninstallModule(key: string): Promise<{
    success: boolean;
    dataPreserved?: { totalRows: number; tables: any[] };
    message?: string;
  }> {
    try {
      const res = await fetch(`${API_URL}/api/modules/${key}/uninstall`, {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const result = await res.json();
        // Refresh modules to update the list
        await this.fetchModules();
        return {
          success: true,
          dataPreserved: result.dataPreserved,
          message: result.message,
        };
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || err.message || t("modulesStore.couldNotUninstall"));
        return { success: false };
      }
    } catch {
      alert(t("modulesStore.uninstallNetworkError"));
      return { success: false };
    }
  }

  /**
   * Recover/Reinstall an uninstalled kon with its data.
   */
  async recoverModule(
    key: string
  ): Promise<{ success: boolean; dataRestored?: { totalRows: number }; message?: string }> {
    try {
      const res = await fetch(`${API_URL}/api/modules/${key}/recover`, {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const result = await res.json();
        // Refresh modules to update the list
        await this.fetchModules();
        return {
          success: true,
          dataRestored: result.dataRestored,
          message: result.message,
        };
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || err.message || t("modulesStore.couldNotRecover"));
        return { success: false };
      }
    } catch {
      alert(t("modulesStore.networkErrorOnRecover"));
      return { success: false };
    }
  }

  /**
   * Permanently delete a kon and optionally its data.
   * @param purge - If true, also drops the tables and data
   */
  async deleteModule(
    key: string,
    purge: boolean = false
  ): Promise<{
    success: boolean;
    dataDeleted?: { tablesDropped: number; totalRows: number };
    message?: string;
  }> {
    try {
      const res = await fetch(`${API_URL}/api/modules/${key}?purge=${purge}&force=true`, {
        method: "DELETE",
        credentials: "include",
      });

      if (res.ok) {
        const result = await res.json();
        // Refresh modules to update the list
        await this.fetchModules();
        return {
          success: true,
          dataDeleted: result.dataDeleted,
          message: result.message,
        };
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || err.message || t("modulesStore.couldNotRemove"));
        return { success: false };
      }
    } catch {
      alert(t("modulesStore.networkErrorOnRemove"));
      return { success: false };
    }
  }

  /**
   * Check if a module is enabled by key.
   */
  isEnabled(key: string): boolean {
    return this.enabledKeys.has(key);
  }
}

export const moduleStore = new ModuleStore();
