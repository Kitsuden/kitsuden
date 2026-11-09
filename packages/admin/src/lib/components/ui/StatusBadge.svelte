<!--
  StatusBadge: a status on tallao's Badge (src/lib/tallao), with its dot (`dot`, and `pulse`
  for the live states, which stops under reduced motion). Only the variant names and the
  uppercase are the admin's.
-->
<script lang="ts">
  import { Badge } from "$lib/tallao";

  type StatusVariant =
    | "default"
    | "success"
    | "error"
    | "warning"
    | "info"
    | "active"
    | "inactive"
    | "pending"
    | "archived";

  type StatusSize = "sm" | "md" | "lg";

  interface Props {
    /** Badge color variant */
    variant?: StatusVariant;
    /** Badge size */
    size?: StatusSize;
    /** Text to show */
    label?: string;
    /** Show dot indicator */
    dot?: boolean;
    /** Additional classes */
    class?: string;
    children?: import("svelte").Snippet;
  }

  const {
    variant = "default",
    size = "md",
    label,
    dot = true,
    class: className = "",
    children,
  }: Props = $props();

  const badgeVariant = {
    default: "default",
    success: "success",
    error: "error",
    warning: "warning",
    info: "info",
    active: "success",
    inactive: "default",
    pending: "warning",
    archived: "secondary",
  } as const;

  const pulses: Partial<Record<StatusVariant, boolean>> = { active: true, pending: true };
</script>

<Badge
  variant={badgeVariant[variant]}
  size={size === "lg" ? "md" : "sm"}
  dot={dot && !pulses[variant]}
  pulse={dot && !!pulses[variant]}
  class="uppercase tracking-wider {size === 'sm' ? 'text-[10px]' : ''} {className}"
>
  {#if label}
    {label}
  {/if}
  {@render children?.()}
</Badge>
