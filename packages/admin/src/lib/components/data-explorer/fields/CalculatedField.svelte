<script lang="ts">
  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";
  import { calculatedHelpers } from "$lib/data-explorer/fieldRegistry";

  const { value, row, config }: FieldComponentProps = $props();

  // Evaluate the calculation if it comes as a function
  const calculatedValue = $derived.by(() => {
    if (config.options?.calculate && typeof config.options.calculate === "function") {
      try {
        return config.options.calculate(row);
      } catch (err) {
        console.error("Error calculating field:", err);
        return null;
      }
    }
    return value;
  });

  /**
   * ── `$derived.by(fn)` RETURNS THE VALUE, NOT A GETTER ────────────────────
   *
   * Here `calculatedValue()` was read, with parentheses, and that throws
   *
   *     TypeError: calculatedValue is not a function
   *
   * which in the minified bundle shows up as «e(...) is not a function» and takes down
   * the rendering of the whole row: the table is left with the spinner on
   * and «0 records», with no further clue.
   *
   * The confusion has a reason: `$derived(() => …)` stores THE FUNCTION —and
   * then it is called—, while `$derived.by(() => …)` runs it and
   * stores the RESULT. The two read almost the same and do the opposite.
   */
  const displayValue = $derived.by(() => {
    const val = calculatedValue;
    if (val === null || val === undefined) return "—";

    const format = config.options?.format;

    switch (format) {
      case "currency":
        return calculatedHelpers.currency(Number(val));
      case "percentage":
        return `${Number(val).toFixed(1)}%`;
      case "datetime":
        return calculatedHelpers.dateFormat(val, "YYYY-MM-DD HH:mm");
      case "badge":
        return val; // Rendered below
      default:
        return String(val);
    }
  });

  const isBadge = $derived(config.options?.format === "badge");
</script>

{#if isBadge}
  <span
    class="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-kitsuden-accent/10 text-kitsuden-accent"
  >
    {displayValue}
  </span>
{:else}
  <span class="text-kitsuden-text-dim tabular-nums">
    {displayValue}
  </span>
{/if}
