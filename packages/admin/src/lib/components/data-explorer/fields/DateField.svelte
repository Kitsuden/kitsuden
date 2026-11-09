<script lang="ts">
  import { Calendar } from "lucide-svelte";

  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";

  const { value, config, mode, onChange }: FieldComponentProps = $props();

  const formattedDate = $derived.by(() => {
    if (!value) return "—";
    const date = new Date(value);
    if (isNaN(date.getTime())) return "—";

    const format = config.options?.format || "YYYY-MM-DD";
    const map: Record<string, string> = {
      YYYY: date.getFullYear().toString(),
      MM: String(date.getMonth() + 1).padStart(2, "0"),
      DD: String(date.getDate()).padStart(2, "0"),
    };

    return format.replace(/YYYY|MM|DD/g, (match: string) => map[match]);
  });

  const inputValue = $derived(value ? new Date(value).toISOString().split("T")[0] : "");
</script>

{#if mode === "view" || mode === "inline"}
  <span class="inline-flex items-center gap-1.5 text-kitsuden-text-dim">
    <Calendar class="w-3.5 h-3.5" />
    <!-- No parentheses: `$derived.by` already stores the value. See CalculatedField. -->
    {formattedDate}
  </span>
{:else}
  <input
    type="date"
    value={inputValue}
    class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
    oninput={(e) => {
      const date = e.currentTarget.valueAsDate;
      onChange?.(date ? date.toISOString() : null);
    }}
  />
{/if}
