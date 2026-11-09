<script lang="ts">
  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";

  const { value, config, mode, onChange }: FieldComponentProps = $props();

  const displayValue = $derived(value ?? "—");
  const isEditing = $state(mode === "edit");
</script>

{#if mode === "view" || mode === "inline"}
  <span class="text-kitsuden-text truncate" title={String(displayValue)}>
    {displayValue}
  </span>
{:else}
  <input
    type="text"
    value={value ?? ""}
    placeholder={config.options?.placeholder}
    maxlength={config.options?.maxLength}
    class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-none focus:border-kitsuden-accent"
    oninput={(e) => onChange?.(e.currentTarget.value)}
  />
{/if}
