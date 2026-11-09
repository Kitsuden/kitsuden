<!--
  tallao — Icon
  Stroke icons (24×24, text colour). A small set of our own with `name`, or
  any other drawing with the `children` snippet (e.g. paths from another collection).
  Without `label` it is decorative (aria-hidden); with `label` it is an image with that name.
  An icon-only button needs its own name (Button ariaLabel), not
  the icon's.
-->
<script lang="ts" module>
  // Our own strokes, drawn for this kit (not copied from another collection).
  export const ICONS = {
    check: "M5 12.5l4.5 4.5L19 7.5",
    x: "M6 6l12 12M18 6L6 18",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    "chevron-left": "M15 6l-6 6 6 6",
    "chevron-right": "M9 6l6 6-6 6",
    "chevron-up": "M6 15l6-6 6 6",
    "chevron-down": "M6 9l6 6 6-6",
    "arrow-left": "M19 12H5M11 6l-6 6 6 6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20",
    menu: "M4 7h16M4 12h16M4 17h16",
    home: "M4 11l8-7 8 7M6 9.5V20h12V9.5",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
    trash: "M4 7h16M10 7V4.5h4V7M6.5 7l1 13h9l1-13",
    edit: "M14.5 5.5l4 4L9 19H5v-4l9.5-9.5z",
    copy: "M9 9h10v10H9zM5 15V5h10",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
    calendar: "M5 6h14v14H5zM5 10h14M9 3.5v4M15 3.5v4",
    clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2",
    info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 11v5.5M12 7.6v.1",
    alert: "M12 4l9 16H3l9-16zM12 10v4.5M12 17.4v.1",
    external: "M14 5h5v5M19 5l-8 8M17 14v5H5V7h5",
    eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    filter: "M4 5h16l-6.5 7.5V19l-3-1.5v-5L4 5z",
    settings:
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    bot: "M6 9h12v10H6zM12 9V5.5M12 5.5a1 1 0 1 0 0-.1M9.5 13.5v1M14.5 13.5v1M3.5 13v3M20.5 13v3",
  } as const;

  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  import { cn } from "../utils";

  const {
    name,
    size = 16,
    strokeWidth = 2,
    label,
    class: className = "",
    children,
  }: {
    name?: IconName;
    size?: number | string;
    strokeWidth?: number;
    /** Accessible name; without it the icon is decorative. */
    label?: string;
    class?: string;
    /** Custom drawing inside the <svg> (viewBox 0 0 24 24). */
    children?: import("svelte").Snippet;
  } = $props();
</script>

<svg
  class={cn("ta-icon", className)}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
  focusable="false"
>
  {#if children}{@render children()}{:else if name}<path d={ICONS[name]} />{/if}
</svg>

<style>
  .ta-icon {
    display: inline-block;
    flex-shrink: 0;
    vertical-align: middle;
  }
</style>
