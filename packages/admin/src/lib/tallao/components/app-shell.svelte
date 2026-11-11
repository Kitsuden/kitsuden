<!--
  tallao — AppShell
  The frame of an application: the sidebar on the left, a top bar (breadcrumb, command
  button, user menu) and the page under it. Sidebar draws the navigation; this lays it out
  and gives it its phone behaviour.

    <AppShell>
      {#snippet sidebar({ mobile, close })}
        <Sidebar {groups} {current} collapsible={!mobile} persistKey={mobile ? undefined : "nav"} />
      {/snippet}
      {#snippet breadcrumb()}<Breadcrumb items={trail} />{/snippet}
      {#snippet command()}<Button variant="secondary" size="sm" onclick={openPalette}>Search <Kbd keys={["Mod", "K"]} /></Button>{/snippet}
      {#snippet user()}<Avatar name="Ana López" size="sm" />{/snippet}
      …the page…
    </AppShell>

  - From the breakpoint up (`breakpoint`: "sm" 640px, "md" 768px, "lg" 1024px) the sidebar is
    a column that stays while the page scrolls. Below it the column is hidden with CSS and
    the top bar shows a menu button (`aria-haspopup="dialog"`, `aria-expanded`) that opens
    the same sidebar in a modal sheet on the left (a Dialog: contained focus, Escape, focus
    back on the button). The `sidebar` snippet is rendered in both places and is told which
    one (`mobile`), with `close` to call when a link is followed. Widening the window past
    the breakpoint closes the sheet.
  - It works rendered on the server and before hydration: the switch is a media query, not a
    measurement. Without JavaScript the phone layout has no navigation: give it links of its
    own (a BottomNav) if the page must work without it.
  - Landmarks: the top bar is the page's `<header>` and the content its `<main>` (focusable,
    the target of a "Skip to content" link that shows on focus). Inside a page that already
    has them (a kon view in the admin, a demo) pass `landmarks={false}` for plain `<div>`s.
  - `height` (100dvh by default) is the frame's height: the page scrolls inside `<main>`, so
    a sticky SaveBar stays at the bottom of the window. `height="auto"` lets the document
    scroll instead.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import Dialog from "./dialog.svelte";
  import Icon from "./icon.svelte";

  interface Props {
    /** Below it the sidebar becomes a sheet behind a menu button. */
    breakpoint?: "sm" | "md" | "lg";
    /** The phone sheet is open (bindable). */
    sidebarOpen?: boolean;
    /** Height of the frame (a CSS length), or "auto" to let the document scroll. */
    height?: string;
    /** `false`: no <header> / <main> / skip link, for a shell inside a page that has them. */
    landmarks?: boolean;
    /** Id of the content region (the skip link's target). */
    mainId?: string;
    /** Accessible name of the menu button. */
    menuLabel?: string;
    /** Accessible name of the phone sheet. */
    navLabel?: string;
    skipLabel?: string;
    closeLabel?: string;
    class?: string;
    /** The navigation (a Sidebar). Gets `{ mobile, close }`: whether it is in the sheet, and how to close it. */
    sidebar?: Snippet<[{ mobile: boolean; close: () => void }]>;
    /** Start of the top bar, after the menu button: where you are. */
    breadcrumb?: Snippet;
    /** End of the top bar: the button that opens the command palette. */
    command?: Snippet;
    /** End of the top bar, last: the user menu. */
    user?: Snippet;
    /** Anything else in the top bar, between the command button and the user. */
    topbar?: Snippet;
    /** The page. */
    children?: Snippet;
  }

  const L = useLabels();
  const generated = $props.id();
  let {
    breakpoint = "md",
    sidebarOpen = $bindable(false),
    height = "100dvh",
    landmarks = true,
    mainId = `${generated}-main`,
    menuLabel = L.openNavigation,
    navLabel = L.navigation,
    skipLabel = L.skipToContent,
    closeLabel,
    class: className = "",
    sidebar,
    breadcrumb,
    command,
    user,
    topbar,
    children,
  }: Props = $props();

  const WIDTHS = { sm: 640, md: 768, lg: 1024 };
  const close = () => (sidebarOpen = false);

  // The sheet belongs to the narrow layout: past the breakpoint the column is back.
  $effect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(`(min-width: ${WIDTHS[breakpoint]}px)`);
    const sync = () => {
      if (query.matches) sidebarOpen = false;
    };
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  });
</script>

<div class={cn("ta-shell", `ta-shell--${breakpoint}`, className)} style:height={height === "auto" ? undefined : height}>
  {#if landmarks}<a class="ta-shell-skip" href={`#${mainId}`}>{skipLabel}</a>{/if}
  {#if sidebar}
    <div class="ta-shell-side">{@render sidebar({ mobile: false, close })}</div>
  {/if}
  <div class="ta-shell-body">
    <svelte:element this={landmarks ? "header" : "div"} class="ta-shell-top">
      {#if sidebar}
        <button
          type="button"
          class="ta-shell-menu"
          aria-label={menuLabel}
          aria-haspopup="dialog"
          aria-expanded={sidebarOpen}
          onclick={() => (sidebarOpen = true)}
        >
          <Icon name="menu" size={18} />
        </button>
      {/if}
      <div class="ta-shell-trail">{@render breadcrumb?.()}</div>
      <div class="ta-shell-tools">
        {@render command?.()}
        {@render topbar?.()}
        {@render user?.()}
      </div>
    </svelte:element>
    <svelte:element this={landmarks ? "main" : "div"} id={mainId} class="ta-shell-main" tabindex={landmarks ? -1 : undefined}>
      {@render children?.()}
    </svelte:element>
  </div>
  {#if sidebar}
    <Dialog bind:open={sidebarOpen} placement="left" ariaLabel={navLabel} {closeLabel} showCloseAlone class="ta-shell-sheet">
      {#if sidebarOpen}{@render sidebar({ mobile: true, close })}{/if}
    </Dialog>
  {/if}
</div>

<style>
  .ta-shell {
    position: relative;
    display: flex;
    min-width: 0;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
  }

  .ta-shell-skip {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 20;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-accent) / 0.6);
    border-radius: var(--ta-radius);
    transform: translateY(-200%);
  }
  .ta-shell-skip:focus { transform: none; outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 2px; }

  /* The column: as tall as the frame, its own scroll. Hidden below the breakpoint. */
  .ta-shell-side { display: none; flex: 0 0 auto; min-height: 0; }
  .ta-shell-side > :global(*) { height: 100%; }

  .ta-shell-body { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }

  .ta-shell-top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 0 0 auto;
    min-height: 3.25rem;
    padding: 0.5rem 1rem;
    background: rgb(var(--ta-bg));
    border-bottom: 1px solid rgb(var(--ta-border));
  }

  .ta-shell-menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2.25rem;
    height: 2.25rem;
    margin-left: -0.375rem;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius);
    cursor: pointer;
  }
  .ta-shell-menu:hover { color: rgb(var(--ta-text)); background: rgb(var(--ta-elevated)); }
  .ta-shell-menu:focus-visible { outline: 2px solid rgb(var(--ta-accent) / 0.6); outline-offset: 1px; }

  .ta-shell-trail { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 0.8125rem; }
  /* One line: the trail is cut with an ellipsis on its last item instead of growing the bar. */
  .ta-shell-trail :global(ol) { flex-wrap: nowrap; min-width: 0; }
  .ta-shell-trail :global(li) { flex: 0 0 auto; white-space: nowrap; }
  .ta-shell-trail :global(li:last-child) { flex: 0 1 auto; min-width: 0; }
  .ta-shell-trail :global(li:last-child > span) { overflow: hidden; text-overflow: ellipsis; }
  .ta-shell-tools { display: flex; align-items: center; flex: 0 0 auto; gap: 0.5rem; }

  .ta-shell-main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    padding: 1.5rem;
    overflow: auto;
    outline: none;
  }

  /* The phone sheet: the sidebar fills it. */
  .ta-shell :global(.ta-shell-sheet) { width: min(18rem, 86vw); }
  .ta-shell :global(.ta-shell-sheet .ta-dialog-body) { display: flex; padding: 0; }
  .ta-shell :global(.ta-shell-sheet .ta-dialog-body > *) { flex: 1; width: auto; border-right: none; }

  @media (max-width: 480px) {
    .ta-shell-top { padding: 0.5rem 0.75rem; }
    .ta-shell-main { padding: 1rem; }
  }

  @media (min-width: 640px) {
    .ta-shell--sm > .ta-shell-side { display: block; }
    .ta-shell--sm .ta-shell-menu { display: none; }
  }
  @media (min-width: 768px) {
    .ta-shell--md > .ta-shell-side { display: block; }
    .ta-shell--md .ta-shell-menu { display: none; }
  }
  @media (min-width: 1024px) {
    .ta-shell--lg > .ta-shell-side { display: block; }
    .ta-shell--lg .ta-shell-menu { display: none; }
  }

  @media (pointer: coarse) {
    .ta-shell-menu { width: 2.75rem; height: 2.75rem; }
    .ta-shell-skip { min-height: 2.75rem; display: inline-flex; align-items: center; }
  }
</style>
