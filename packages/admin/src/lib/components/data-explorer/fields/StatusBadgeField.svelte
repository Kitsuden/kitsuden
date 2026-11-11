<script lang="ts">
  import type { FieldComponentProps } from "$lib/data-explorer/fieldRegistry";

  const { value, config }: FieldComponentProps = $props();

  // Default colors for common states
  const defaultColors: Record<string, string> = {
    draft: "bg-kitsuden-amber/10 text-kitsuden-amber border-kitsuden-amber/20",
    published: "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20",
    archived: "bg-kitsuden-subtle/10 text-kitsuden-text-dim border-kitsuden-subtle/20",
    active: "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20",
    inactive: "bg-kitsuden-subtle/10 text-kitsuden-text-dim border-kitsuden-subtle/20",
    pending: "bg-kitsuden-amber/10 text-kitsuden-amber border-kitsuden-amber/20",
    approved: "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20",
    rejected: "bg-kitsuden-danger/10 text-kitsuden-danger border-kitsuden-danger/20",
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
