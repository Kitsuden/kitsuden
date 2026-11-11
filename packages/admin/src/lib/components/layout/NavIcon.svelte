<!--
  The icon of a sidebar entry. The shell's own entries name a lucide icon bundled here; a
  kon's entry carries whatever its manifest declared (a lucide name or an emoji), which
  KonIcon understands.
-->
<script lang="ts">
  import {
    Activity,
    Archive,
    Blocks,
    Book,
    Bot,
    Boxes,
    Brain,
    FileText,
    ImageIcon,
    LayoutDashboard,
    Plug,
    Settings,
    ShieldCheck,
    Table2,
    Zap,
  } from "lucide-svelte";

  import KonIcon from "$lib/components/KonIcon.svelte";

  const SHELL = {
    Activity,
    Archive,
    Blocks,
    Book,
    Bot,
    Boxes,
    Brain,
    FileText,
    ImageIcon,
    LayoutDashboard,
    Plug,
    Settings,
    ShieldCheck,
    Table2,
    Zap,
  } as const;

  const { name, size = 16 }: { name?: string | null; size?: number } = $props();
  const Icon = $derived(name ? SHELL[name as keyof typeof SHELL] : undefined);
</script>

{#if Icon}
  <Icon {size} class="shrink-0" aria-hidden="true" />
{:else}
  <KonIcon {name} {size} class="shrink-0" />
{/if}
