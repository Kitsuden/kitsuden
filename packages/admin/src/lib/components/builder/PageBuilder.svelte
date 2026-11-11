<script lang="ts">
  import { Button } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import {
    LayoutGrid,
    Plus,
    GripVertical,
    ChevronUp,
    ChevronDown,
    Copy,
    Trash2,
    Sparkles,
    FileText,
    Images,
    Map,
    Tv,
    Code2,
    AlertTriangle,
    Minus,
  } from "lucide-svelte";
  import { rise } from "$lib/tallao/motion";

  import { createBlock, getBlockDef, type PageBlock, type BlockType } from "../../../types/blocks";

  import BlockEditor from "./BlockEditor.svelte";
  import BlockPicker from "./BlockPicker.svelte";

  interface Props {
    blocks?: PageBlock[];
    onChange?: (blocks: PageBlock[]) => void;
  }

  const { blocks = [], onChange }: Props = $props();

  let panelMode = $state<"picker" | "editor" | null>(null);
  let selectedBlockId = $state<string | null>(null);
  let dragOverIdx = $state(-1);
  let dragSourceIdx = $state(-1);

  const selectedBlock = $derived(blocks.find((b) => b.id === selectedBlockId) || null);

  const iconMap: Record<string, typeof Sparkles> = {
    Sparkles,
    FileText,
    Images,
    Map,
    Tv,
    Code2,
    AlertTriangle,
    Minus,
  };

  function getBlockColor(type: BlockType): string {
    return getBlockDef(type)?.color || "#888";
  }
  function getBlockIcon(type: BlockType): typeof Sparkles {
    const def = getBlockDef(type);
    return iconMap[def?.icon || "FileText"] || FileText;
  }
  function getBlockLabel(type: BlockType): string {
    return getBlockDef(type)?.label || type;
  }

  function getBlockPreview(block: PageBlock): string {
    const d = block.data;
    switch (block.type) {
      case "hero":
        return d.title || t("pageBuilder.untitledHero");
      case "richtext":
        return d.content?.slice(0, 60) || t("pageBuilder.emptyContent");
      case "image-gallery":
        return `${(d.images || []).length} images · ${d.layout || "grid"}`;
      case "game-map":
        return d.mapTitle || d.mapImageUrl || t("pageBuilder.noMapConfigured");
      case "streamer-widget":
        return `${d.platform}/${d.channelName || "?"}`;
      case "embed":
        return d.url || t("pageBuilder.noEmbedUrl");
      case "callout":
        return `${d.variant}: ${d.content?.slice(0, 40) || "empty"}`;
      case "facebook-group":
        return d.url || t("pageBuilder.withoutGroupLink");
      case "divider":
        return d.style || "gradient";
      default:
        return JSON.stringify(d).slice(0, 50);
    }
  }

  function updateBlocks(newBlocks: PageBlock[]) {
    onChange?.(newBlocks);
  }

  function addBlock(type: BlockType) {
    const block = createBlock(type, blocks.length);
    updateBlocks([...blocks, block]);
    selectedBlockId = block.id;
    panelMode = "editor";
  }

  function selectBlock(id: string) {
    selectedBlockId = id;
    panelMode = "editor";
  }
  function updateBlock(updated: PageBlock) {
    updateBlocks(blocks.map((b) => (b.id === updated.id ? updated : b)));
  }

  function removeBlock(idx: number) {
    const id = blocks[idx].id;
    updateBlocks(blocks.filter((_, i) => i !== idx));
    if (selectedBlockId === id) {
      selectedBlockId = null;
      panelMode = null;
    }
    reorder();
  }

  function removeSelectedBlock() {
    if (!selectedBlockId) return;
    updateBlocks(blocks.filter((b) => b.id !== selectedBlockId));
    selectedBlockId = null;
    panelMode = null;
    reorder();
  }

  function duplicateBlock(idx: number) {
    const src = blocks[idx];
    const clone: PageBlock = {
      ...structuredClone(src),
      id: `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      order: idx + 1,
    };
    const updated = [...blocks];
    updated.splice(idx + 1, 0, clone);
    updateBlocks(updated);
    reorder();
  }

  function moveBlock(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= blocks.length) return;
    const updated = [...blocks];
    [updated[idx], updated[target]] = [updated[target], updated[idx]];
    updateBlocks(updated);
    reorder();
  }

  function reorder() {
    updateBlocks(blocks.map((b, i) => ({ ...b, order: i })));
  }

  function onDragStart(e: DragEvent, idx: number) {
    dragSourceIdx = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("source-idx", String(idx));
    }
  }

  function onReorder(targetIdx: number) {
    const sourceIdx = dragSourceIdx;
    if (sourceIdx >= 0 && sourceIdx !== targetIdx) {
      const updated = [...blocks];
      const [moved] = updated.splice(sourceIdx, 1);
      updated.splice(targetIdx, 0, moved);
      updateBlocks(updated);
      reorder();
    }
    dragSourceIdx = -1;
    dragOverIdx = -1;
  }

  function onDropFromPicker(e: DragEvent) {
    const type = e.dataTransfer?.getData("block-type");
    if (type) addBlock(type as import("../../../types/blocks").BlockType);
    dragOverIdx = -1;
  }
</script>

<div
  class="flex h-[calc(100vh-14rem)] gap-0 rounded-xl border border-kitsuden-border overflow-hidden bg-kitsuden-card"
>
  <div
    class="flex-1 overflow-y-auto bg-kitsuden-bg"
    ondragover={(e) => e.preventDefault()}
    ondrop={(e) => {
      e.preventDefault();
      onDropFromPicker(e);
    }}
  >
    <div
      class="sticky top-0 z-10 flex items-center justify-between px-4 py-2.5 border-b border-kitsuden-border bg-kitsuden-card/95 backdrop-blur-xs"
    >
      <div class="flex items-center gap-2">
        <LayoutGrid class="w-4 h-4 text-kitsuden-accent" />
        <span class="text-xs font-semibold text-kitsuden-text"
          >{t("pageBuilder.layoutBuilder")}</span
        >
        <span class="badge-cyan text-xs">{blocks.length} {t("pageBuilder.blocks")}</span>
      </div>
      <Button
        onclick={() => (panelMode = panelMode === "picker" ? null : "picker")}
        variant="ghost"
        size="sm"><Plus class="w-3.5 h-3.5" /> {t("pageBuilder.addBlock")}</Button
      >
    </div>

    {#if blocks.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-kitsuden-subtle">
        <LayoutGrid class="w-14 h-14 mb-5 text-kitsuden-subtle" />
        <p class="text-sm font-medium mb-1">{t("pageBuilder.noBlocksYet")}</p>
        <p class="text-xs mb-6">{t("pageBuilder.clickAddBlockOrDrag")}</p>
        <Button onclick={() => (panelMode = "picker")} size="sm"
          ><Plus class="w-3.5 h-3.5" /> {t("pageBuilder.addYourFirstBlock")}</Button
        >
      </div>
    {:else}
      <div class="p-4 space-y-2">
        {#each blocks as block, idx}
          <div
            draggable="true"
            ondragstart={(e) => onDragStart(e, idx)}
            ondragover={(e) => {
              e.preventDefault();
              dragOverIdx = idx;
            }}
            ondrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onReorder(idx);
            }}
            ondragend={() => {
              dragOverIdx = -1;
              dragSourceIdx = -1;
            }}
            class="group rounded-xl border transition-all duration-200 cursor-pointer {selectedBlockId ===
            block.id
              ? 'border-kitsuden-accent-50 shadow-[0_0_20px_rgba(168, 85, 247, 0.1)] bg-kitsuden-accent/3'
              : 'border-kitsuden-border hover:border-kitsuden-border/80 bg-kitsuden-card'} {dragOverIdx ===
              idx && dragSourceIdx !== idx
              ? 'ring-2 ring-kitsuden-accent-30 ring-inset'
              : ''}"
            onclick={() => selectBlock(block.id)}
          >
            <div class="flex items-center gap-3 px-4 py-3">
              <GripVertical
                class="w-4 h-4 text-kitsuden-subtle shrink-0 opacity-0 group-hover:opacity-60 cursor-grab transition-opacity"
              />
              {#if true}
                {@const BlockIcon = getBlockIcon(block.type)}
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style="background: {getBlockColor(
                    block.type
                  )}15; border: 1px solid {getBlockColor(block.type)}20"
                >
                  <BlockIcon class="w-4 h-4" style="color: {getBlockColor(block.type)}" />
                </div>
              {/if}
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-kitsuden-text">{getBlockLabel(block.type)}</p>
                <p class="text-xs text-kitsuden-subtle truncate">{getBlockPreview(block)}</p>
              </div>
              <span
                class="text-xs font-mono text-kitsuden-subtle bg-kitsuden-bg rounded-sm px-1.5 py-0.5 shrink-0"
                >{idx + 1}</span
              >
              <div
                class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <Button
                  onclick={(e) => {
                    e.stopPropagation();
                    moveBlock(idx, -1);
                  }}
                  disabled={idx === 0}
                  variant="ghost"
                  size="icon"
                  title={t("pageBuilder.moveUp")}><ChevronUp class="w-3.5 h-3.5" /></Button
                >
                <Button
                  onclick={(e) => {
                    e.stopPropagation();
                    moveBlock(idx, 1);
                  }}
                  disabled={idx === blocks.length - 1}
                  variant="ghost"
                  size="icon"
                  title={t("pageBuilder.moveDown")}><ChevronDown class="w-3.5 h-3.5" /></Button
                >
                <Button
                  onclick={(e) => {
                    e.stopPropagation();
                    duplicateBlock(idx);
                  }}
                  variant="ghost"
                  size="icon"
                  title={t("pageBuilder.duplicate")}><Copy class="w-3.5 h-3.5" /></Button
                >
                <Button
                  onclick={(e) => {
                    e.stopPropagation();
                    removeBlock(idx);
                  }}
                  variant="danger-ghost"
                  size="icon"
                  title={t("common.delete")}><Trash2 class="w-3.5 h-3.5" /></Button
                >
              </div>
            </div>
            {#if block.type === "divider"}
              <div class="px-4 pb-3">
                {#if block.data.style === "gradient"}<div
                    class="h-px bg-linear-to-r from-transparent via-kitsuden-accent/30 to-transparent"
                  ></div>{:else if block.data.style === "line"}<div
                    class="h-px bg-kitsuden-border"
                  ></div>{:else if block.data.style === "dots"}<div
                    class="flex items-center justify-center gap-2"
                  >
                    <span class="w-1 h-1 rounded-full bg-kitsuden-subtle"></span><span
                      class="w-1 h-1 rounded-full bg-kitsuden-subtle"
                    ></span><span class="w-1 h-1 rounded-full bg-kitsuden-subtle"></span>
                  </div>{:else}<div class="h-6"></div>{/if}
              </div>
            {:else if block.type === "hero" && block.data.imageUrl}
              <div class="mx-4 mb-3 rounded-lg overflow-hidden border border-kitsuden-border/50">
                <img src={block.data.imageUrl} class="w-full h-20 object-cover opacity-60" alt="" />
              </div>
            {:else if block.type === "callout"}
              <div
                class="mx-4 mb-3 rounded-lg px-3 py-2 text-xs {block.data.variant === 'info'
                  ? 'bg-kitsuden-info/10 border border-kitsuden-info/20 text-kitsuden-info'
                  : block.data.variant === 'warning'
                    ? 'bg-kitsuden-amber/10 border border-kitsuden-amber/20 text-kitsuden-amber'
                    : block.data.variant === 'success'
                      ? 'bg-kitsuden-green/10 border border-kitsuden-green/20 text-kitsuden-green'
                      : block.data.variant === 'danger'
                        ? 'bg-kitsuden-danger/10 border border-kitsuden-danger/20 text-kitsuden-danger'
                        : 'bg-kitsuden-purple/10 border border-kitsuden-purple/20 text-kitsuden-purple'}"
              >
                {block.data.content?.slice(0, 80) || t("pageBuilder.emptyCallout")}{block.data
                  .content?.length > 80
                  ? "…"
                  : ""}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if panelMode}
    <div
      transition:rise
      class="w-80 shrink-0 border-l border-kitsuden-border bg-kitsuden-card overflow-hidden"
    >
      {#if panelMode === "picker"}
        <BlockPicker onAdd={(type) => addBlock(type)} onClose={() => (panelMode = null)} />
      {:else if panelMode === "editor" && selectedBlock}
        <BlockEditor
          block={selectedBlock}
          onUpdate={(updated) => updateBlock(updated)}
          onDelete={removeSelectedBlock}
          onClose={() => {
            panelMode = null;
            selectedBlockId = null;
          }}
        />
      {/if}
    </div>
  {/if}
</div>
