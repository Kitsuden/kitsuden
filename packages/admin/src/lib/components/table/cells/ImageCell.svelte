<script lang="ts">
  /**
   * ImageCell.svelte
   *
   * Table cell to show images with a preview.
   */
  import { ImageIcon } from "lucide-svelte";

  interface Props {
    /** Image URL */
    src?: string | null;
    /** Alternative text */
    alt?: string;
    /** Image size */
    size?: "sm" | "md" | "lg";
    /** Show as a circle */
    rounded?: boolean;
    /** Fallback if there is no image */
    fallback?: "icon" | "initials" | "none";
  }

  const { src, alt = "", size = "md", rounded = true, fallback = "icon" }: Props = $props();

  const sizeClasses = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-12 h-12",
  };

  let isError = $state(false);
  let isLoading = $state(true);

  function handleError() {
    isError = true;
    isLoading = false;
  }

  function handleLoad() {
    isLoading = false;
  }

  // Get initials from the alt text
  const initials = $derived(
    alt
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  );
</script>

<div class="flex items-center gap-3">
  <div
    class="relative overflow-hidden bg-kitsuden-card border border-kitsuden-border flex items-center justify-center {sizeClasses[
      size
    ]}"
    class:rounded-lg={!rounded}
    class:rounded-full={rounded}
  >
    {#if src && !isError}
      <img
        {src}
        {alt}
        class="w-full h-full object-cover"
        class:opacity-0={isLoading}
        class:opacity-100={!isLoading}
        on:error={handleError}
        on:load={handleLoad}
      />
      {#if isLoading}
        <div class="absolute inset-0 flex items-center justify-center">
          <div
            class="w-4 h-4 border-2 border-kitsuden-border border-t-kitsuden-accent rounded-full animate-spin"
          ></div>
        </div>
      {/if}
    {:else if fallback === "icon"}
      <ImageIcon class="w-4 h-4 text-kitsuden-subtle" />
    {:else if fallback === "initials" && alt}
      <span class="text-xs font-medium text-kitsuden-text-dim">{initials}</span>
    {/if}
  </div>

  {#if alt}
    <span class="text-sm text-kitsuden-text truncate">{alt}</span>
  {/if}
</div>
