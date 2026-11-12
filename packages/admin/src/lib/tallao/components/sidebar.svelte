<!--
  tallao — Sidebar
  Side navigation for a dashboard: groups with a title, links with an icon and badge,
  and entries with children that expand (a button with aria-expanded). The current
  page (`current`, an href or an id) gets aria-current="page", and its branch opens
  on its own. `collapsed` leaves only the icons: the names stay there for screen
  readers and show in a Tooltip on hover or focus (`tooltips={false}`: a plain `title`).

  - Icons: `icon` on an item is a kit icon name or a snippet; the `icon` prop draws every
    item's icon with your own set (lucide-svelte, for example) and gets the item.
  - Badges: `badgeVariant` tints the counter like a Badge, and `badgeDot` / `badgePulse` add
    the status dot (a pending-approvals count that pulses). Collapsed, a badge becomes a dot
    on the icon.
  - `persistKey`: remembers `collapsed` in localStorage under that key (opt-in; read after
    mount, so the server renders the default).
  - `footer` gets `collapsed`: render only an avatar then, with the name as its `title`.
-->
<script lang="ts" module>
  import type { Snippet } from "svelte";

  import type { IconName } from "./icon.svelte";

  export interface SidebarItem {
    id: string;
    label: string;
    href?: string;
    /** A kit icon by name, or your own drawing as a snippet. */
    icon?: IconName | Snippet;
    badge?: string | number;
    /** Tone of the badge, as in Badge; without it, the neutral counter. */
    badgeVariant?:
      "default" | "secondary" | "success" | "warning" | "error" | "info" | "accent" | "accent-2";
    /** A status dot before the badge text. */
    badgeDot?: boolean;
    /** The dot pulses (still under reduced motion). Implies `badgeDot`. */
    badgePulse?: boolean;
    children?: SidebarItem[];
    onclick?: () => void;
  }

  export interface SidebarGroup {
    label?: string;
    items: SidebarItem[];
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import Icon from "./icon.svelte";
  import Tooltip from "./tooltip.svelte";

  const L = useLabels();
  let {
    groups,
    current,
    collapsed = $bindable(false),
    ariaLabel = L.navigation,
    collapseLabel = L.collapse,
    expandLabel = L.expand,
    /** Shows the button that collapses the bar. */
    collapsible = true,
    persistKey,
    tooltips = true,
    class: className = "",
    header,
    footer,
    icon,
  }: {
    groups: SidebarGroup[];
    current?: string;
    collapsed?: boolean;
    ariaLabel?: string;
    collapseLabel?: string;
    expandLabel?: string;
    collapsible?: boolean;
    /** Remembers `collapsed` in localStorage under this key. */
    persistKey?: string;
    /** Collapsed: the label in a Tooltip on hover and focus; `false` uses `title` instead. */
    tooltips?: boolean;
    class?: string;
    header?: Snippet;
    /** Bottom area (the current user); gets `collapsed`. */
    footer?: Snippet<[boolean]>;
    /** Draws every item's icon with your own set; gets the item. */
    icon?: Snippet<[SidebarItem]>;
  } = $props();

  // Remembered state: read once after mount (the server and the first render use the prop),
  // then written on every change. localStorage can throw (private mode, blocked storage).
  let restored = $state(false);
  $effect(() => {
    if (!persistKey || restored) return;
    try {
      const saved = localStorage.getItem(persistKey);
      if (saved === "true" || saved === "false") collapsed = saved === "true";
    } catch {
      /* no storage: keep the prop */
    }
    restored = true;
  });
  $effect(() => {
    const value = collapsed;
    if (!persistKey || !restored) return;
    try {
      localStorage.setItem(persistKey, String(value));
    } catch {
      /* no storage: nothing to remember */
    }
  });

  // The label is already the item's accessible name (hidden text): the tooltip only shows it.
  const withoutDescription = (props: Record<string | symbol, unknown>) => {
    const { "aria-describedby": _, ...others } = props;
    return others;
  };

  const id = $props.id();
  const isCurrent = (it: SidebarItem) =>
    current != null && (it.href === current || it.id === current);
  const containsCurrent = (it: SidebarItem): boolean =>
    isCurrent(it) || !!it.children?.some(containsCurrent);

  let open = $state<Record<string, boolean>>({});
  // The current page's branch opens when you reach it (and does not close on its own afterwards).
  $effect(() => {
    void current;
    untrack(() => {
      for (const g of groups)
        for (const it of g.items) if (it.children && containsCurrent(it)) open[it.id] = true;
    });
  });
</script>

<nav
  class={cn("ta-sidebar", collapsed && "ta-sidebar--collapsed", className)}
  aria-label={ariaLabel}
>
  {#if header || collapsible}
    <div class="ta-sidebar-header">
      {#if header && !collapsed}<div class="ta-sidebar-brand">{@render header()}</div>{/if}
      {#if collapsible}
        <button
          type="button"
          class="ta-sidebar-collapse"
          aria-label={collapsed ? expandLabel : collapseLabel}
          aria-expanded={!collapsed}
          onclick={() => (collapsed = !collapsed)}
        >
          <Icon name={collapsed ? "chevron-right" : "chevron-left"} />
        </button>
      {/if}
    </div>
  {/if}

  {#snippet entry(it: SidebarItem, level: number)}
    {#if it.children?.length && !collapsed}
      <button
        type="button"
        class="ta-sidebar-item"
        style:--ta-sidebar-level={level}
        aria-expanded={!!open[it.id]}
        aria-controls={`${id}-${it.id}`}
        onclick={() => (open[it.id] = !open[it.id])}
      >
        {@render itemIcon(it)}
        <span class="ta-sidebar-text">{it.label}</span>
        <Icon name={open[it.id] ? "chevron-down" : "chevron-right"} class="ta-sidebar-chevron" />
      </button>
      {#if open[it.id]}
        <ul id={`${id}-${it.id}`}>
          {#each it.children as child (child.id)}<li>{@render entry(child, level + 1)}</li>{/each}
        </ul>
      {/if}
    {:else if collapsed && tooltips}
      <Tooltip text={it.label} placement="right">
        {#snippet trigger(props)}{@render leaf(it, level, withoutDescription(props))}{/snippet}
      </Tooltip>
    {:else}
      {@render leaf(it, level, {})}
    {/if}
  {/snippet}

  {#snippet itemIcon(it: SidebarItem)}
    {@const custom = typeof it.icon === "function" ? it.icon : null}
    {#if custom}
      <span class="ta-sidebar-icon" aria-hidden="true">{@render custom()}</span>
    {:else if icon}
      <span class="ta-sidebar-icon" aria-hidden="true">{@render icon(it)}</span>
    {:else if typeof it.icon === "string"}
      <Icon name={it.icon} />
    {/if}
  {/snippet}

  {#snippet itemBadge(it: SidebarItem)}
    {#if it.badge != null && it.badge !== ""}
      {@const dot = it.badgeDot || it.badgePulse}
      <span
        class={cn(
          "ta-sidebar-badge",
          it.badgeVariant && `ta-sidebar-badge--${it.badgeVariant}`,
          it.badgePulse && "ta-sidebar-badge--pulse"
        )}
        >{#if dot}<span class="ta-sidebar-dot" aria-hidden="true"></span>{/if}{it.badge}</span
      >
      {#if collapsed}<span
          class={cn(
            "ta-sidebar-pip",
            it.badgeVariant && `ta-sidebar-badge--${it.badgeVariant}`,
            it.badgePulse && "ta-sidebar-badge--pulse"
          )}
          aria-hidden="true"
        ></span>{/if}
    {/if}
  {/snippet}

  {#snippet leaf(it: SidebarItem, level: number, props: Record<string | symbol, unknown>)}
    {#if it.href}
      <a
        {...props}
        href={it.href}
        class="ta-sidebar-item"
        style:--ta-sidebar-level={level}
        aria-current={isCurrent(it) ? "page" : undefined}
        title={collapsed && !tooltips ? it.label : undefined}
        onclick={it.onclick}
      >
        {@render itemIcon(it)}
        <span class="ta-sidebar-text">{it.label}</span>
        {@render itemBadge(it)}
      </a>
    {:else}
      <button
        {...props}
        type="button"
        class="ta-sidebar-item"
        style:--ta-sidebar-level={level}
        aria-current={isCurrent(it) ? "page" : undefined}
        title={collapsed && !tooltips ? it.label : undefined}
        onclick={it.onclick}
      >
        {@render itemIcon(it)}
        <span class="ta-sidebar-text">{it.label}</span>
        {@render itemBadge(it)}
      </button>
    {/if}
  {/snippet}

  <div class="ta-sidebar-body">
    {#each groups as g, gi (gi)}
      <div class="ta-sidebar-group">
        {#if g.label}<div class="ta-sidebar-title" id={`${id}-g${gi}`}>{g.label}</div>{/if}
        <ul aria-labelledby={g.label ? `${id}-g${gi}` : undefined}>
          {#each g.items as it (it.id)}<li>{@render entry(it, 0)}</li>{/each}
        </ul>
      </div>
    {/each}
  </div>

  {#if footer}<div class="ta-sidebar-footer">{@render footer(collapsed)}</div>{/if}
</nav>

<style>
  .ta-sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 15rem;
    height: 100%;
    padding: 0.5rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface) / 0.5);
    border-right: 1px solid rgb(var(--ta-border));
    transition: width 0.15s;
  }
  .ta-sidebar--collapsed {
    width: 3.25rem;
  }

  .ta-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 2rem;
  }
  .ta-sidebar-brand {
    min-width: 0;
    font-weight: 600;
  }
  .ta-sidebar-collapse {
    display: flex;
    padding: 0.375rem;
    margin-left: auto;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-sidebar-collapse:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated));
  }

  .ta-sidebar-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .ta-sidebar ul {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ta-sidebar-title {
    margin: 0 0 0.25rem;
    padding: 0 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }
  .ta-sidebar--collapsed .ta-sidebar-title,
  .ta-sidebar--collapsed .ta-sidebar-text,
  .ta-sidebar--collapsed .ta-sidebar-badge {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .ta-sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.5rem 0.4rem calc(0.5rem + var(--ta-sidebar-level, 0) * 1rem);
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    text-decoration: none;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius);
    cursor: pointer;
  }
  .ta-sidebar-item:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated) / 0.6);
  }
  .ta-sidebar-item:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: -2px;
  }
  .ta-sidebar-item[aria-current="page"] {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-accent) / 0.15);
    font-weight: 500;
  }
  .ta-sidebar--collapsed .ta-sidebar-item {
    justify-content: center;
    padding: 0.5rem;
  }

  .ta-sidebar-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ta-sidebar-badge {
    padding: 0 0.4rem;
    font-size: 0.6875rem;
    line-height: 1.25rem;
    border-radius: 9999px;
    background: rgb(var(--ta-elevated));
  }
  .ta-sidebar :global(.ta-sidebar-chevron) {
    opacity: 0.6;
  }

  .ta-sidebar-icon {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
  }
  .ta-sidebar-icon > :global(svg) {
    width: 1rem;
    height: 1rem;
  }

  /* Badge tones (as in Badge) and the status dot. */
  .ta-sidebar-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .ta-sidebar-pip {
    color: rgb(var(--ta-accent-hover));
  }
  .ta-sidebar-badge--secondary {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-muted));
  }
  .ta-sidebar-badge--success {
    color: rgb(var(--ta-success));
    background: rgb(var(--ta-success) / 0.15);
  }
  .ta-sidebar-badge--warning {
    color: rgb(var(--ta-warning));
    background: rgb(var(--ta-warning) / 0.15);
  }
  .ta-sidebar-badge--error {
    color: rgb(var(--ta-danger));
    background: rgb(var(--ta-danger) / 0.15);
  }
  .ta-sidebar-badge--info {
    color: rgb(var(--ta-info));
    background: rgb(var(--ta-info) / 0.15);
  }
  .ta-sidebar-badge--accent {
    color: rgb(var(--ta-accent-hover));
    background: rgb(var(--ta-accent) / 0.15);
  }
  .ta-sidebar-badge--accent-2 {
    color: rgb(var(--ta-accent-2));
    background: rgb(var(--ta-accent-2) / 0.15);
  }
  .ta-sidebar-dot,
  .ta-sidebar-pip {
    position: relative;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: currentColor;
  }
  .ta-sidebar-badge--pulse .ta-sidebar-dot::after,
  .ta-sidebar-pip.ta-sidebar-badge--pulse::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: currentColor;
    animation: ta-sidebar-pulse 1.6s ease-out infinite;
  }
  @keyframes ta-sidebar-pulse {
    from {
      transform: scale(1);
      opacity: 0.6;
    }
    to {
      transform: scale(2.6);
      opacity: 0;
    }
  }

  /* Collapsed: the badge becomes a dot on the icon's corner. */
  .ta-sidebar--collapsed .ta-sidebar-item {
    position: relative;
  }
  .ta-sidebar-pip {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    width: 0.5rem;
    height: 0.5rem;
    background: currentColor;
    box-shadow: 0 0 0 2px rgb(var(--ta-surface));
  }
  .ta-sidebar-pip[class*="ta-sidebar-badge--"] {
    background: currentColor;
  }

  .ta-sidebar-footer {
    border-top: 1px solid rgb(var(--ta-border));
    padding-top: 0.5rem;
    min-width: 0;
  }
  .ta-sidebar--collapsed .ta-sidebar-footer {
    display: flex;
    justify-content: center;
    overflow: hidden;
  }

  @media (pointer: coarse) {
    .ta-sidebar-item {
      min-height: 2.75rem;
    }
    .ta-sidebar-collapse {
      min-width: 2.75rem;
      min-height: 2.75rem;
      justify-content: center;
      align-items: center;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-sidebar {
      transition: none;
    }
    .ta-sidebar-badge--pulse .ta-sidebar-dot::after,
    .ta-sidebar-pip.ta-sidebar-badge--pulse::after {
      animation: none;
      display: none;
    }
  }
</style>
