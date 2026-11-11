<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { History, Trash2, RotateCcw } from "lucide-svelte";

  import { autosaveStore } from "$lib/states/autosave.svelte";

  interface Props {
    onRestore?: () => void;
  }

  const { onRestore }: Props = $props();

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString(localeFormat());
  }

  function handleRestore(index: number) {
    autosaveStore.restoreVersion(index);
    onRestore?.();
  }

  async function handleDeleteAll() {
    if (await confirmDialog(t("versionHistory.deleteAllAutosavedVersionsFor"))) {
      autosaveStore.deleteAllVersions();
    }
  }
</script>

<div>
  <div class="flex items-center justify-between mb-2 pb-2 border-b border-kitsuden-border">
    <h3 class="text-sm font-semibold text-kitsuden-text flex items-center gap-2">
      <History class="w-4 h-4 text-kitsuden-accent" />
      {t("versionHistory.versionHistory")}
    </h3>
    {#if autosaveStore.versions.length > 0}
      <button
        class="text-xs text-kitsuden-danger hover:text-kitsuden-danger flex items-center gap-1 transition-colors"
        onclick={handleDeleteAll}
      >
        <Trash2 class="w-3 h-3" />
        {t("versionHistory.deleteAll")}
      </button>
    {/if}
  </div>

  {#if autosaveStore.versions.length === 0}
    <p class="text-sm text-kitsuden-text-dim text-center py-4">
      {t("versionHistory.noAutosavedVersionsYet")}
    </p>
  {:else}
    <div class="space-y-2 max-h-64 overflow-y-auto pr-1">
      {#each autosaveStore.versions as version, i}
        <div
          class="flex items-center justify-between gap-2 p-2 rounded-lg bg-kitsuden-bg border border-kitsuden-border hover:border-kitsuden-accent/30 transition-colors"
        >
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-kitsuden-text">
              {t("versionHistory.version", { i: autosaveStore.versions.length - i })}
            </p>
            <p class="text-xs text-kitsuden-text-dim truncate">
              {formatTime(version.timestamp)}
            </p>
          </div>
          <button
            class="px-2 py-1 text-xs font-medium rounded-md bg-kitsuden-accent/10 text-kitsuden-accent hover:bg-kitsuden-accent/20 transition-colors flex items-center gap-1 shrink-0"
            onclick={() => handleRestore(i)}
          >
            <RotateCcw class="w-3 h-3" />
            {t("versionHistory.restore")}
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
