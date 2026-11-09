<script lang="ts">
  /**
   * A kon's icon, however it comes.
   *
   * ── TWO CONVENTIONS COEXISTING ───────────────────────────────────────────
   *
   * In this repo the `icon` field means two different things depending on where
   * it comes from, and that is NOT an oversight that can be "fixed" by deleting one:
   *
   *   · `/api/modules` (module-registry.ts) returns EMOJIS: «🖼️», «🗃️», «🧱».
   *   · `kon.json` and the admin registry return lucide NAMES:
   *     «Gamepad2», «FileText», «Tv».
   *
   * The emojis belong to the core modules, written by hand; the names, to the
   * kons discovered from the file system. The admin list mixes
   * both sources, so this component has to understand both.
   *
   * ── THE TWO FAILURES THIS FIXES ──────────────────────────────────────────
   *
   * 1. Rendering everything as text: lucide names came out as the word
   *    «Gamepad2» overflowing the card.
   * 2. Rendering everything as a component: emojis are not in the map, so
   *    they fell back to the generic icon and ALL cards showed the same box.
   *
   * Both looked like "that's how it's designed".
   */
  import { ICONS } from "$lib/icons";
  import Package from "lucide-svelte/icons/package";

  const {
    name,
    size = 18,
    class: kind = "",
  }: { name?: string | null; size?: number; class?: string } = $props();

  const Icon = $derived(name ? ICONS[name] : undefined);

  /**
   * Is it an emoji (or any glyph) rather than a component name?
   *
   * A lucide name is always a PascalCase identifier. Whatever is not
   * is rendered as-is: that way an emoji looks like an emoji, and a misspelled
   * name is seen literally — which is ugly, but visible, and therefore
   * gets fixed. The generic icon would hide it.
   */
  const isGlyph = $derived(!!name && !Icon && !/^[A-Z][A-Za-z0-9]*$/.test(name));
</script>

{#if Icon}
  <Icon {size} class={kind} />
{:else if isGlyph}
  <span class={kind} style="font-size: {size}px; line-height: 1">{name}</span>
{:else}
  <Package {size} class={kind} />
{/if}
