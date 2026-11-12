<!--
  tallao — Tooltip
  Short text that describes a control, on hover or when it gets keyboard focus
  (WCAG 1.4.13: it can be dismissed with Escape, does not cover things by accident
  and does not disappear when the pointer moves over it). It holds no controls:
  that is what Popover is for. The text is linked to the trigger with aria-describedby.

    <Tooltip text="Copy link">
      {#snippet trigger(props)}<Button {...props} size="icon" ariaLabel="Copy">⧉</Button>{/snippet}
    </Tooltip>
-->
<script lang="ts">
  import { createAttachmentKey } from "svelte/attachments";

  import { pushLayer } from "../internal/layers";
  import { anchor, type Placement } from "../internal/position";

  import type { TriggerProps } from "./popover.svelte";

  interface Props {
    text: string;
    placement?: Placement;
    /** Wait before showing on hover, in ms (focus shows it immediately). */
    delay?: number;
    trigger: import("svelte").Snippet<[TriggerProps]>;
  }

  const { text, placement = "top", delay = 400, trigger }: Props = $props();

  const id = $props.id();
  let open = $state(false);
  let triggerEl: HTMLElement | null = $state(null);
  let bubble: HTMLElement | undefined = $state();
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function show(wait: number) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(() => (open = true), wait);
  }

  // A short grace period so the pointer can move from the trigger to the bubble.
  function hide() {
    clearTimeout(showTimer);
    hideTimer = setTimeout(() => (open = false), 100);
  }

  const triggerProps = $derived({
    "aria-describedby": `${id}-tooltip`,
    onpointerenter: () => show(delay),
    onpointerleave: hide,
    onfocus: () => show(0),
    onblur: hide,
    [createAttachmentKey()]: (node: HTMLElement) => {
      triggerEl = node;
      return () => {
        if (triggerEl === node) triggerEl = null;
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
      };
    },
  });

  $effect(() => {
    const b = bubble;
    const a = triggerEl;
    if (!open || !b || !a) return;
    const release = anchor(a, b, { placement, gap: 8 });
    // Escape dismisses it; a click outside leaves it alone (it is not an interactive layer).
    const remove = pushLayer({
      inside: () => [a, b],
      dismiss: () => (open = false),
      escapeOnly: true,
    });
    return () => {
      remove();
      release();
    };
  });
</script>

{@render trigger(triggerProps)}

<!-- Always in the DOM (hidden) so aria-describedby points at something real. -->
<div
  bind:this={bubble}
  id={`${id}-tooltip`}
  role="tooltip"
  popover="manual"
  class="ta-tooltip"
  class:ta-tooltip--open={open}
  onpointerenter={() => clearTimeout(hideTimer)}
  onpointerleave={hide}
>
  {text}
</div>

<style>
  .ta-tooltip {
    animation: ta-tooltip-enter var(--ta-duration-fast, 120ms) ease-out;
  }
  @keyframes ta-tooltip-enter {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ta-tooltip {
      animation: none;
    }
  }

  .ta-tooltip {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 60;
    display: none;
    max-width: 18rem;
    padding: 0.3rem 0.55rem;
    font: inherit;
    font-size: 0.75rem;
    line-height: 1.4;
    color: rgb(var(--ta-bg));
    background: rgb(var(--ta-text));
    border: none;
    border-radius: var(--ta-radius-sm);
    box-shadow: 0 6px 16px -6px rgb(0 0 0 / 0.5);
    overflow: visible;
  }

  .ta-tooltip--open {
    display: block;
  }
</style>
