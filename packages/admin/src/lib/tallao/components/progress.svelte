<!--
  tallao — Progress
  Progress bar (role="progressbar"). Without `value` it is indeterminate: something
  is running and how much remains is unknown. Needs `label` (its name).
-->
<script lang="ts">
  import { cn } from "../utils";

  const {
    value,
    max = 100,
    label,
    /** Text a screen reader reads instead of the percentage (e.g. "3 of 8 tasks"). */
    valueText,
    showValue = false,
    variant = "default",
    class: className = "",
  }: {
    value?: number | null;
    max?: number;
    label: string;
    valueText?: string;
    showValue?: boolean;
    variant?: "default" | "success" | "warning" | "error";
    class?: string;
  } = $props();

  const determinate = $derived(typeof value === "number" && Number.isFinite(value));
  const pct = $derived(
    determinate ? Math.min(100, Math.max(0, ((value as number) / max) * 100)) : 0
  );
</script>

<div class={cn("ta-progress", `ta-progress--${variant}`, className)}>
  <div class="ta-progress-header">
    <span class="ta-progress-label">{label}</span>
    {#if showValue && determinate}<span class="ta-progress-value"
        >{valueText ?? `${Math.round(pct)}%`}</span
      >{/if}
  </div>
  <div
    class="ta-progress-track"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={determinate ? value : undefined}
    aria-valuetext={determinate ? valueText : undefined}
  >
    <div
      class="ta-progress-bar"
      class:ta-progress-bar--indeterminate={!determinate}
      style:width={determinate ? `${pct}%` : undefined}
    ></div>
  </div>
</div>

<style>
  .ta-progress {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .ta-progress-header {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .ta-progress-value {
    font-variant-numeric: tabular-nums;
  }

  .ta-progress-track {
    height: 0.5rem;
    overflow: hidden;
    border-radius: 9999px;
    background: rgb(var(--ta-elevated));
  }

  .ta-progress-bar {
    height: 100%;
    border-radius: inherit;
    background: rgb(var(--ta-accent));
    transition: width var(--ta-duration-slow, 240ms) var(--ta-ease-out, ease-out);
  }
  .ta-progress--success .ta-progress-bar {
    background: rgb(var(--ta-success));
  }
  .ta-progress--warning .ta-progress-bar {
    background: rgb(var(--ta-warning));
  }
  .ta-progress--error .ta-progress-bar {
    background: rgb(var(--ta-danger));
  }

  .ta-progress-bar--indeterminate {
    width: 35%;
    animation: ta-progress-sweep 1.2s ease-in-out infinite;
  }

  @keyframes ta-progress-sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-progress-bar {
      transition: none;
    }
    .ta-progress-bar--indeterminate {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }
</style>
