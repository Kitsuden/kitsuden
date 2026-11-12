<!--
  tallao — SplitPane
  Two panels with a draggable separator (editor and preview, list and detail).
  The separator is accessible (role="separator" from the WAI-ARIA APG "window
  splitter" pattern): it takes focus, the arrows move by `step`, Home and End go
  to the minimum and maximum, and Enter toggles between collapsing the first panel
  and its last size. `size` is the first panel's percentage.
-->
<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();
  let {
    size = $bindable(50),
    min = 15,
    max = 85,
    step = 5,
    orientation = "horizontal",
    label = L.resize,
    class: className = "",
    first,
    second,
    onresize,
  }: {
    size?: number;
    min?: number;
    max?: number;
    step?: number;
    /** horizontal: panels side by side; vertical: one above the other. */
    orientation?: "horizontal" | "vertical";
    /** Accessible name of the separator. */
    label?: string;
    class?: string;
    first: import("svelte").Snippet;
    second: import("svelte").Snippet;
    onresize?: (size: number) => void;
  } = $props();

  const id = $props.id();
  let container: HTMLElement | undefined = $state();
  let previous = 50;

  function setSize(v: number) {
    const n = Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
    if (n === size) return;
    size = n;
    onresize?.(n);
  }

  function onKey(e: KeyboardEvent) {
    const decrease = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const increase = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (e.key === decrease) setSize(size - step);
    else if (e.key === increase) setSize(size + step);
    else if (e.key === "Home") setSize(min);
    else if (e.key === "End") setSize(max);
    else if (e.key === "Enter") {
      if (size > min) {
        previous = size;
        setSize(min);
      } else setSize(previous);
    } else return;
    e.preventDefault();
  }

  function drag(e: PointerEvent) {
    if (!container || e.button !== 0) return;
    const separator = e.currentTarget as HTMLElement;
    separator.setPointerCapture?.(e.pointerId);
    const r = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct =
        orientation === "horizontal"
          ? ((ev.clientX - r.left) / r.width) * 100
          : ((ev.clientY - r.top) / r.height) * 100;
      if (Number.isFinite(pct)) setSize(pct);
    };
    const release = () => {
      separator.removeEventListener("pointermove", move);
      separator.removeEventListener("pointerup", release);
    };
    separator.addEventListener("pointermove", move);
    separator.addEventListener("pointerup", release);
  }
</script>

<div
  bind:this={container}
  class={cn("ta-split", `ta-split--${orientation}`, className)}
  style:--ta-split-size={`${size}%`}
>
  <div class="ta-split-panel" id={`${id}-first`}>{@render first()}</div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="ta-split-separator"
    role="separator"
    tabindex="0"
    aria-label={label}
    aria-orientation={orientation === "horizontal" ? "vertical" : "horizontal"}
    aria-controls={`${id}-first`}
    aria-valuenow={size}
    aria-valuemin={min}
    aria-valuemax={max}
    onkeydown={onKey}
    onpointerdown={drag}
  ></div>
  <div class="ta-split-panel">{@render second()}</div>
</div>

<style>
  .ta-split {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  .ta-split--horizontal {
    grid-template-columns: var(--ta-split-size) 6px minmax(0, 1fr);
  }
  .ta-split--vertical {
    grid-template-rows: var(--ta-split-size) 6px minmax(0, 1fr);
  }

  .ta-split-panel {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .ta-split-separator {
    position: relative;
    background: transparent;
    touch-action: none;
    outline: none;
  }
  .ta-split--horizontal .ta-split-separator {
    cursor: col-resize;
  }
  .ta-split--vertical .ta-split-separator {
    cursor: row-resize;
  }

  /* The visible line is thin; the grab area is the full 6px. */
  .ta-split-separator::after {
    content: "";
    position: absolute;
    background: rgb(var(--ta-border));
    transition: background-color 0.15s;
  }
  .ta-split--horizontal .ta-split-separator::after {
    top: 0;
    bottom: 0;
    left: 2.5px;
    width: 1px;
  }
  .ta-split--vertical .ta-split-separator::after {
    left: 0;
    right: 0;
    top: 2.5px;
    height: 1px;
  }

  .ta-split-separator:hover::after,
  .ta-split-separator:focus-visible::after {
    background: rgb(var(--ta-accent));
  }
  .ta-split--horizontal .ta-split-separator:focus-visible::after {
    left: 1.5px;
    width: 3px;
  }
  .ta-split--vertical .ta-split-separator:focus-visible::after {
    top: 1.5px;
    height: 3px;
  }
  @media (pointer: coarse) {
    .ta-split-separator::before {
      content: "";
      position: absolute;
    }
    .ta-split--horizontal .ta-split-separator::before {
      top: 0;
      bottom: 0;
      left: 50%;
      width: 2.75rem;
      transform: translateX(-50%);
    }
    .ta-split--vertical .ta-split-separator::before {
      left: 0;
      right: 0;
      top: 50%;
      height: 2.75rem;
      transform: translateY(-50%);
    }
  }
</style>
