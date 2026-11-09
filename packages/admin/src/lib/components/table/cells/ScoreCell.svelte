<script lang="ts">
  /**
   * ScoreCell.svelte
   *
   * Cell to show scores/ratings with visual progress bars.
   */
  import { Star, TrendingUp, TrendingDown, Minus } from "lucide-svelte";

  interface Props {
    /** Score value (0-100) */
    value?: number;
    /** Maximum value */
    max?: number;
    /** Show as a percentage */
    showPercentage?: boolean;
    /** Show progress bar */
    showBar?: boolean;
    /** Size */
    size?: "sm" | "md" | "lg";
    /** Show trend (up/down/neutral) */
    trend?: "up" | "down" | "neutral";
  }

  const {
    value = 0,
    max = 100,
    showPercentage = true,
    showBar = true,
    size = "md",
    trend = "neutral",
  }: Props = $props();

  const percentage = $derived(Math.round((value / max) * 100));

  // Color based on the score
  const colorClass = $derived.by(() => {
    if (percentage >= 80) return "bg-kitsuden-green";
    if (percentage >= 60) return "bg-kitsuden-accent";
    if (percentage >= 40) return "bg-kitsuden-amber";
    return "bg-kitsuden-accent-2";
  });

  const sizeClasses = {
    sm: { bar: "h-1", text: "text-xs", icon: "w-3 h-3" },
    md: { bar: "h-1.5", text: "text-sm", icon: "w-4 h-4" },
    lg: { bar: "h-2", text: "text-base", icon: "w-5 h-5" },
  };
</script>

<div class="flex items-center gap-3 min-w-[120px]">
  <!-- Progress bar -->
  {#if showBar}
    <div class="flex-1 bg-kitsuden-border rounded-full overflow-hidden {sizeClasses[size].bar}">
      <div
        class="h-full rounded-full transition-all duration-300 {colorClass}"
        style="width: {percentage}%"
      ></div>
    </div>
  {/if}

  <!-- Numeric value -->
  <div class="flex items-center gap-1.5 shrink-0">
    {#if trend === "up"}
      <TrendingUp class="{sizeClasses[size].icon} text-kitsuden-green" />
    {:else if trend === "down"}
      <TrendingDown class="{sizeClasses[size].icon} text-kitsuden-accent-2" />
    {:else}
      <Minus class="{sizeClasses[size].icon} text-kitsuden-subtle" />
    {/if}

    <span class="font-medium {sizeClasses[size].text} text-kitsuden-text">
      {showPercentage ? `${percentage}%` : value}
    </span>

    {#if percentage >= 90}
      <Star class="w-3 h-3 text-kitsuden-amber fill-kitsuden-amber" />
    {/if}
  </div>
</div>
