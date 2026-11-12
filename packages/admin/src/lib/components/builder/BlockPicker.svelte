<script lang="ts">
  import { Button } from "$lib/tallao";
  import { t } from "$lib/i18n";
  /**
   * BlockPicker.svelte — Grid of available blocks to add
   */
  import {
    X,
    Sparkles,
    FileText,
    Images,
    Map,
    Tv,
    Code2,
    AlertTriangle,
    Minus,
    Clapperboard,
    SlidersHorizontal,
    Columns,
    Table2,
  } from "lucide-svelte";

  import { BLOCK_REGISTRY, type BlockType } from "../../../types/blocks";

  interface Props {
    onAdd?: (type: BlockType) => void;
    onClose?: () => void;
  }

  const { onAdd, onClose }: Props = $props();

  const iconMap: Record<string, typeof Sparkles> = {
    Sparkles,
    FileText,
    Images,
    Map,
    Tv,
    Code2,
    AlertTriangle,
    Minus,
    Clapperboard,
    SlidersHorizontal,
    Columns,
    Table2,
  };

  const categories = [
    { id: "content", label: t("common.content") },
    { id: "media", label: t("common.media") },
    { id: "interactive", label: t("blockPicker.interactive") },
    { id: "layout", label: t("blockPicker.layout") },
  ];

  function getBlockIcon(iconName: string): typeof Sparkles {
    return iconMap[iconName] || FileText;
  }
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="p-4 border-b border-kitsuden-border flex items-center justify-between">
    <h3 class="text-sm font-semibold text-kitsuden-text">{t("blockPicker.addBlock")}</h3>
    <Button onclick={onClose} variant="ghost" size="icon" ariaLabel={t("blockPicker.close")}
      ><X class="w-4 h-4" /></Button
    >
  </div>

  <!-- Block Categories -->
  <div class="flex-1 overflow-y-auto p-4 space-y-6">
    {#each categories as cat}
      {@const catBlocks = BLOCK_REGISTRY.filter((b) => b.category === cat.id)}
      {#if catBlocks.length > 0}
        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle mb-3">
            {cat.label}
          </h4>
          <div class="grid grid-cols-2 gap-2">
            {#each catBlocks as block}
              <button
                draggable="true"
                ondragstart={(e) => {
                  if (e.dataTransfer) e.dataTransfer.setData("block-type", block.type);
                }}
                onclick={() => onAdd?.(block.type)}
                class="group flex flex-col items-center gap-2 p-3 rounded-xl border border-kitsuden-border hover:border-kitsuden-accent/50 hover:bg-kitsuden-accent/3 transition-all text-center"
              >
                {#if true}
                  {@const BlockIcon = getBlockIcon(block.icon)}
                  <div
                    class="w-10 h-10 rounded-lg flex items-center justify-center transition-colors"
                    style="background: {block.color}15; border: 1px solid {block.color}25"
                  >
                    <BlockIcon class="w-5 h-5" style="color: {block.color}" />
                  </div>
                {/if}
                <div>
                  <p
                    class="text-xs font-medium text-kitsuden-text group-hover:text-kitsuden-text transition-colors"
                  >
                    {block.label}
                  </p>
                  <p class="text-xs text-kitsuden-subtle mt-0.5 line-clamp-2">
                    {block.description}
                  </p>
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <!-- Footer tip -->
  <div class="p-3 border-t border-kitsuden-border bg-kitsuden-bg/50">
    <p class="text-xs text-kitsuden-subtle text-center">
      {t("blockPicker.tipYouCanAlsoDrag")}
    </p>
  </div>
</div>
