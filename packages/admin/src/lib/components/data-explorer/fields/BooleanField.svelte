<script lang="ts">
  import { t } from "$lib/i18n";
  import { Check, X } from "lucide-svelte";

  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";

  const { value, mode, onChange }: FieldComponentProps = $props();

  const isTrue = $derived(!!value);
</script>

{#if mode === "view" || mode === "inline"}
  <span class="inline-flex items-center gap-1.5">
    {#if isTrue}
      <Check class="w-4 h-4 text-kitsuden-green" />
      <span class="text-kitsuden-green text-sm">{t("common.yes")}</span>
    {:else}
      <X class="w-4 h-4 text-kitsuden-subtle" />
      <span class="text-kitsuden-subtle text-sm">{t("common.no")}</span>
    {/if}
  </span>
{:else}
  <label class="flex items-center gap-3 cursor-pointer">
    <input
      type="checkbox"
      checked={isTrue}
      class="w-5 h-5 rounded border-kitsuden-border bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent"
      onchange={(e) => onChange?.(e.currentTarget.checked)}
    />
    <span class="text-sm text-kitsuden-text"
      >{isTrue ? t("booleanField.enabled") : t("booleanField.disabled")}</span
    >
  </label>
{/if}
