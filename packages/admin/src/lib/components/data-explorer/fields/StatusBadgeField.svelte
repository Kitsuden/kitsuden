<script lang="ts">
  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";

  const { value, config }: FieldComponentProps = $props();

  // Default colors for common states
  const defaultColors: Record<string, string> = {
    draft: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    published: "bg-green-500/10 text-green-500 border-green-500/20",
    archived: "bg-gray-500/10 text-gray-400 border-gray-500/20",
    active: "bg-green-500/10 text-green-500 border-green-500/20",
    inactive: "bg-gray-500/10 text-gray-400 border-gray-500/20",
    pending: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    approved: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    rejected: "bg-red-500/10 text-red-500 border-red-500/20",
  };

  const statusColors = $derived({ ...defaultColors, ...config.options?.colors });
  const statusClass = $derived(
    statusColors[String(value)?.toLowerCase()] ||
      "bg-kitsuden-surface text-kitsuden-text-dim border-kitsuden-border"
  );
</script>

<span
  class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border {statusClass}"
>
  {value ?? "—"}
</span>
