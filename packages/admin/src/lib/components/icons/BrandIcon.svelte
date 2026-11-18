<!--
  A brand logo, with the same props as a lucide icon (`size`, `class`, and the rest on the <svg>).
  The paths and their licence are in ./brand-icons.ts.
-->
<script lang="ts">
  import type { SVGAttributes } from "svelte/elements";

  import { BRAND_ICONS, type BrandIconName } from "./brand-icons";

  let {
    name,
    size = 24,
    class: className = "",
    ...rest
  }: { name: BrandIconName; size?: number | string } & SVGAttributes<SVGSVGElement> = $props();

  const icon = $derived(BRAND_ICONS[name]);
  // Decorative unless the caller gives it a label (then it is announced by its title).
  const labelled = $derived(Boolean(rest["aria-label"] || rest["aria-labelledby"]));
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="currentColor"
  class="brand-icon {className}"
  role={labelled ? "img" : undefined}
  aria-hidden={labelled ? undefined : "true"}
  focusable="false"
  {...rest}
>
  {#if labelled}<title>{icon.title}</title>{/if}
  <path d={icon.path} />
</svg>
