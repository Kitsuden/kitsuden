<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * RelationCell.svelte
   *
   * Cell to show relations between datasets.
   * Shows badges with the related items.
   */
  import { Link2, ExternalLink } from "lucide-svelte";

  interface RelatedItem {
    id: string;
    label: string;
    href?: string;
  }

  interface Props {
    /** Related items */
    items?: RelatedItem[];
    /** Maximum to show before "+N more" */
    maxItems?: number;
    /** Relation type for the icon */
    type?: "one" | "many";
    /** Click handler */
    onClick?: (item: RelatedItem) => void;
  }

  const { items = [], maxItems = 2, type = "many", onClick }: Props = $props();

  const visibleItems = $derived(items.slice(0, maxItems));
  const remainingCount = $derived(items.length - maxItems);

  function handleClick(item: RelatedItem) {
    if (onClick) {
      onClick(item);
    }
  }
</script>

<div class="flex items-center gap-2">
  <Link2 class="w-3.5 h-3.5 text-kitsuden-subtle shrink-0" />

  {#if items.length === 0}
    <span class="text-xs text-kitsuden-subtle italic">—</span>
  {:else}
    <div class="flex items-center gap-1 flex-wrap">
      {#each visibleItems as item}
        {#if item.href}
          <a
            href={item.href}
            class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-kitsuden-accent-10 text-kitsuden-accent border border-kitsuden-accent-20 hover:bg-kitsuden-accent-20 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              handleClick(item);
            }}
          >
            {item.label}
            <ExternalLink class="w-3 h-3 opacity-50" />
          </a>
        {:else}
          <button
            class="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-kitsuden-accent-10 text-kitsuden-accent border border-kitsuden-accent-20 hover:bg-kitsuden-accent-20 transition-colors"
            onclick={() => handleClick(item)}
          >
            {item.label}
          </button>
        {/if}
      {/each}

      {#if remainingCount > 0}
        <span class="text-xs text-kitsuden-subtle">
          {t("relationCell.more", { remainingCount })}
        </span>
      {/if}
    </div>
  {/if}
</div>
