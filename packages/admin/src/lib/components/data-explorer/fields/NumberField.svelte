<script lang="ts">
  import { localeFormat } from "$lib/i18n";
  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";

  const { value, config, mode, onChange }: FieldComponentProps = $props();

  const displayValue = $derived(
    value !== null && value !== undefined ? Number(value).toLocaleString(localeFormat()) : "—"
  );
</script>

{#if mode === "view" || mode === "inline"}
  <span class="text-kitsuden-text tabular-nums">
    {displayValue}
  </span>
{:else}
  <input
    type="number"
    value={value ?? ""}
    min={config.options?.min}
    max={config.options?.max}
    step={config.options?.step}
    placeholder={config.options?.placeholder}
    class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
    oninput={(e) => onChange?.(e.currentTarget.valueAsNumber)}
  />
{/if}
