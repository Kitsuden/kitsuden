<script lang="ts">
  import { t } from "$lib/i18n";
  interface Props {
    show?: boolean;
    minLeft?: number;
    defaultLeftPercent?: number;
    left?: import("svelte").Snippet;
    right?: import("svelte").Snippet;
  }

  const { show = true, minLeft = 30, defaultLeftPercent = 50, left, right }: Props = $props();

  let containerRef: HTMLDivElement;
  let leftWidth = $state(defaultLeftPercent);
  let isDragging = $state(false);

  function startDrag(e: MouseEvent) {
    isDragging = true;
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onMouseMove(e: MouseEvent) {
    if (!isDragging || !containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(minLeft, Math.min(100 - 20, (x / rect.width) * 100));
    leftWidth = percent;
  }

  function stopDrag() {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  }
</script>

<svelte:window onmousemove={onMouseMove} onmouseup={stopDrag} />

<div bind:this={containerRef} class="flex h-full w-full overflow-hidden">
  <div
    class="h-full overflow-hidden transition-all duration-200"
    style="width: {show ? leftWidth : 100}%"
  >
    {@render left?.()}
  </div>

  {#if show}
    <div
      class="w-1.5 shrink-0 cursor-col-resize bg-kitsuden-border hover:bg-kitsuden-accent/60 active:bg-kitsuden-accent transition-colors relative flex items-center justify-center group"
      onmousedown={startDrag}
      role="separator"
      aria-label={t("splitPane.resizePanels")}
    >
      <div
        class="w-1 h-8 rounded-full bg-kitsuden-subtle/40 group-hover:bg-kitsuden-accent/80 transition-colors"
      ></div>
    </div>

    <div class="h-full overflow-hidden flex-1 bg-kitsuden-bg">
      {@render right?.()}
    </div>
  {/if}
</div>
