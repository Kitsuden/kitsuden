<script lang="ts">
  import { t } from "$lib/i18n";
  import { Archive, Database, Trash2, RotateCcw, Package } from "lucide-svelte";

  import { Badge, Button, Card, CardContent, CardFooter } from "$lib/tallao";
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

<Card class="uninstalled-kon">
  <CardContent class="uninstalled-kon-body">
    <div class="uninstalled-kon-icon" aria-hidden="true">
      <Package size={20} />
    </div>

    <div class="uninstalled-kon-text">
      <div class="uninstalled-kon-title">
        <h3>{kon.name}</h3>
        <Badge variant="secondary">
          <Archive size={10} aria-hidden="true" />
          {t("uninstalledGrimoireCard.uninstalled")}
        </Badge>
      </div>

      {#if kon.hasPreservedData}
        <p class="uninstalled-kon-data">
          <Database size={14} aria-hidden="true" />
          {t("uninstalledGrimoireCard.dataPreservedRows", {
            v: formatNumber(kon.dataSummary.totalRows),
          })}
        </p>

        {#if kon.dataSummary.tables.length > 0}
          <div class="uninstalled-kon-tables">
            {#each kon.dataSummary.tables.slice(0, 3) as table}
              <Badge class="font-mono">{table.name}: {formatNumber(table.rows)}</Badge>
            {/each}
            {#if kon.dataSummary.tables.length > 3}
              <Badge>{t("common.more", { v: kon.dataSummary.tables.length - 3 })}</Badge>
            {/if}
          </div>
        {/if}
      {:else}
        <p class="uninstalled-kon-data">{t("uninstalledGrimoireCard.noDataPreserved")}</p>
      {/if}
    </div>
  </CardContent>

  {#if kon.canRecover || kon.canDelete}
    <CardFooter class="uninstalled-kon-actions">
      {#if kon.canRecover}
        <Button
          variant="secondary"
          size="sm"
          loading={recovering}
          disabled={recovering}
          onclick={onRecover}
        >
          {#if recovering}
            {t("uninstalledGrimoireCard.recovering")}
          {:else}
            <RotateCcw size={14} aria-hidden="true" />
            {t("uninstalledGrimoireCard.recover")}
          {/if}
        </Button>
      {/if}

      {#if kon.canDelete}
        <Button
          variant="danger-ghost"
          size="sm"
          loading={deleting}
          disabled={deleting}
          onclick={onDelete}
        >
          {#if !deleting}<Trash2 size={14} aria-hidden="true" />{/if}
          {t("uninstalledGrimoireCard.permanentlyDeleteData")}
        </Button>
      {/if}
    </CardFooter>
  {/if}
</Card>

<style>
  :global(.uninstalled-kon) {
    border-style: dashed;
    min-width: 0;
  }
  :global(.uninstalled-kon-body) {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .uninstalled-kon-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--ta-radius-lg);
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text-dim));
  }
  .uninstalled-kon-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .uninstalled-kon-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .uninstalled-kon-title h3 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .uninstalled-kon-data {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .uninstalled-kon-tables {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  :global(.ta-card-footer.uninstalled-kon-actions) {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
  }
</style>
