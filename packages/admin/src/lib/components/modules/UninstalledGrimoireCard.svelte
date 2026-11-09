<script lang="ts">
  import { t } from "$lib/i18n";
  import { Archive, Database, Trash2, RotateCcw } from "lucide-svelte";

  import type { UninstalledKon } from "$lib/states/modules.svelte";

  interface Props {
    kon: UninstalledKon;
    onRecover?: () => void;
    onDelete?: () => void;
    recovering?: boolean;
    deleting?: boolean;
  }

  const { kon, onRecover, onDelete, recovering = false, deleting = false }: Props = $props();

  function formatNumber(num: number): string {
    if (num >= 1000) return (num / 1000).toFixed(1) + "k";
    return num.toString();
  }
</script>

<div
  class="card p-5 relative overflow-hidden border-dashed border-kitsuden-border/50 bg-kitsuden-surface/30"
>
  <!-- Dashed border indicator for uninstalled state -->
  <div
    class="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-kitsuden-subtle/40 via-kitsuden-subtle/20 to-transparent"
  ></div>

  <div class="flex items-start gap-3">
    <div
      class="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 bg-kitsuden-surface/50 border border-kitsuden-border/50 grayscale opacity-70"
    >
      📦
    </div>

    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <p class="font-semibold text-kitsuden-text text-sm opacity-80">{kon.name}</p>
        <span
          class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-kitsuden-subtle/20 text-kitsuden-subtle border border-kitsuden-border/50 flex items-center gap-1"
        >
          <Archive class="w-2.5 h-2.5" />
          {t("uninstalledGrimoireCard.uninstalled")}
        </span>
      </div>

      {#if kon.hasPreservedData}
        <div class="mt-2 flex items-center gap-1.5 text-xs text-kitsuden-accent/80">
          <Database class="w-3.5 h-3.5" />
          <span
            >{t("uninstalledGrimoireCard.dataPreservedRows", {
              v: formatNumber(kon.dataSummary.totalRows),
            })}</span
          >
        </div>

        {#if kon.dataSummary.tables.length > 0}
          <div class="mt-1.5 flex flex-wrap gap-1">
            {#each kon.dataSummary.tables.slice(0, 3) as table}
              <span
                class="text-[10px] px-1.5 py-0.5 rounded bg-kitsuden-bg border border-kitsuden-border/50 text-kitsuden-subtle font-mono"
              >
                {table.name}: {formatNumber(table.rows)}
              </span>
            {/each}
            {#if kon.dataSummary.tables.length > 3}
              <span
                class="text-[10px] px-1.5 py-0.5 rounded bg-kitsuden-bg border border-kitsuden-border/50 text-kitsuden-subtle"
              >
                {t("common.more", { v: kon.dataSummary.tables.length - 3 })}
              </span>
            {/if}
          </div>
        {/if}
      {:else}
        <p class="text-xs text-kitsuden-subtle mt-1">
          {t("uninstalledGrimoireCard.noDataPreserved")}
        </p>
      {/if}
    </div>
  </div>

  <!-- Action Buttons -->
  <div class="mt-4 pt-3 border-t border-kitsuden-border/30 flex gap-2">
    {#if kon.canRecover}
      <button
        onclick={onRecover}
        disabled={recovering}
        class="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg transition-colors bg-kitsuden-accent/10 text-kitsuden-accent hover:bg-kitsuden-accent/20 border border-kitsuden-accent/20 disabled:opacity-50"
      >
        {#if recovering}
          <RotateCcw class="w-3.5 h-3.5 animate-spin" />
          {t("uninstalledGrimoireCard.recovering")}
        {:else}
          <RotateCcw class="w-3.5 h-3.5" />
          {t("uninstalledGrimoireCard.recover")}
        {/if}
      </button>
    {/if}

    {#if kon.canDelete}
      <button
        onclick={onDelete}
        disabled={deleting}
        class="flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg transition-colors bg-kitsuden-accent-2/10 text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/20 border border-kitsuden-accent-2/20 disabled:opacity-50"
        title={t("uninstalledGrimoireCard.permanentlyDeleteData")}
      >
        {#if deleting}
          <Trash2 class="w-3.5 h-3.5 animate-pulse" />
        {:else}
          <Trash2 class="w-3.5 h-3.5" />
        {/if}
      </button>
    {/if}
  </div>
</div>

<style>
  .card {
    @apply rounded-xl border border-kitsuden-border bg-kitsuden-card;
  }
</style>
