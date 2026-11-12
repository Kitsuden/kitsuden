<!--
  The panel's frame, on tallao's AppShell.

  Sidebar: Home, then DATA / APPS / AGENTS / PLATFORM as labelled groups and Settings last,
  with the user menu at its foot (`$lib/nav.ts` decides what this user sees). Below the
  breakpoint AppShell turns the sidebar into a sheet behind a menu button.

  Top bar: the Breadcrumb (section › what the page adds; also the source of `<title>`), one
  search button that opens the command palette, the API status as a dot, the user menu.

  Each page draws its own header with `<Page>` (tallao PageHeader); the frame gives the
  content one padding and nothing else.
-->
<script lang="ts">
  import { RefreshCw, Search, Sword } from "lucide-svelte";
  import { onMount, untrack, type Snippet } from "svelte";

  import { getUser, isAdmin as currentUserIsAdmin, isStaff } from "$lib/auth.svelte";
  import { fetchAdminRegistry, hasCustomView } from "$lib/grimoire-loader";
  import { t } from "$lib/i18n";
  import { buildNav, currentEntry, trailFor, type NavEntry } from "$lib/nav";
  import { pageTitle } from "$lib/page";
  import { pageMeta } from "$lib/page-meta.svelte";
  import { recentStore, type RecentItem } from "$lib/recent";
  import { approvals } from "$lib/states/approvals.svelte";
  import { moduleStore } from "$lib/states/modules.svelte";
  import {
    Alert,
    AppShell,
    Breadcrumb,
    Button,
    Kbd,
    Sidebar,
    Tooltip,
    type SidebarGroup,
    type SidebarItem,
  } from "$lib/tallao";

  import CommandCenter from "./CommandCenter.svelte";
  import NavIcon from "./NavIcon.svelte";
  import UserMenu from "./UserMenu.svelte";

  import { page } from "$app/stores";

  const { children }: { children?: Snippet } = $props();

  const me = $derived(getUser());
  const isAdmin = $derived(currentUserIsAdmin());
  const staff = $derived(isStaff());
  const currentPath = $derived($page.url.pathname);

  let paletteOpen = $state(false);
  let apiOnline = $state<boolean | null>(null);

  /**
   * Kons that bring their own screens (a custom view or a Web Component), from the admin
   * registry. Until it answers, only the views bundled in the panel are known.
   */
  let ownScreens = $state<Set<string>>(new Set());
  const bare = (key: string) => key.replace(/^kon-/, "");
  /** `system-tools` → "System tools": the last resort for a kon with no name. */
  const konWords = (key: string) => {
    const words = bare(key).replace(/[-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };

  const groups = $derived(
    buildNav({
      isAdmin,
      isStaff: staff,
      activeKon: (key) => moduleStore.activeKon(key),
      kons: moduleStore.modules,
      hasOwnScreens: (key) => ownScreens.has(bare(key)) || hasCustomView(key),
    })
  );

  const labelOf = (entry: NavEntry) =>
    entry.label ?? (entry.labelKey ? t(entry.labelKey) : entry.id);

  const entry = $derived(currentEntry(groups, currentPath));
  const entries = $derived(new Map(groups.flatMap((g) => g.entries).map((e) => [e.id, e])));

  const toItem = (e: NavEntry, close?: () => void): SidebarItem => {
    const pending = e.id === "approvals" ? approvals.pendingItems : 0;
    return {
      id: e.id,
      label: labelOf(e),
      href: e.path,
      onclick: close,
      ...(pending > 0
        ? { badge: pending, badgeVariant: "warning" as const, badgePulse: true }
        : {}),
    };
  };

  const sidebarGroups = (close?: () => void): SidebarGroup[] =>
    groups.map((g) => ({
      label: g.labelKey ? t(g.labelKey) : undefined,
      items: g.entries.map((e) => toItem(e, close)),
    }));

  // ── Breadcrumb and <title>: one source ───────────────────────────────────────────
  const section = $derived.by(() => {
    if (entry) return { label: labelOf(entry), path: entry.path };
    // A kon's page with no menu entry (a system view, a kon being disabled): the kon's
    // name, else the title its own page shows, else its id in words — never the raw id.
    const kon = currentPath.startsWith("/g/") ? currentPath.split("/")[2] : "";
    if (!kon) return undefined;
    const path = `/g/${kon}`;
    const named = moduleStore.modules.find((m) => m.key === kon)?.name;
    return { label: named || pageMeta.titleFor(path) || konWords(kon), path };
  });
  const extra = $derived(pageMeta.crumbsFor(currentPath));
  const trail = $derived(trailFor(section, extra));
  const title = $derived(pageTitle(trail[trail.length - 1]?.label));

  // ── Recently opened records, from real navigation ────────────────────────────────
  const recents = $derived(recentStore(me?.id ?? ""));
  let recent = $state<RecentItem[]>([]);
  $effect(() => {
    recent = recents.list();
  });
  $effect(() => {
    const last = extra[extra.length - 1];
    // "…" is a page still loading its name: not something to remember.
    if (!last || last.label === "…" || currentPath.endsWith("/new")) return;
    const item = { path: currentPath, label: last.label, section: section?.label };
    untrack(() => {
      recents.push(item);
      recent = recents.list();
    });
  });

  onMount(() => (staff ? approvals.watch() : undefined));

  onMount(async () => {
    const API = import.meta.env.VITE_API_URL ?? "";
    fetch(`${API}/api/health`)
      .then((res) => {
        apiOnline = res.ok;
        // Only the status matters; an unread body keeps the connection open.
        void res.body?.cancel().catch(() => {});
      })
      .catch(() => (apiOnline = false));

    if (!currentUserIsAdmin()) return;
    // `whenLoaded`, not `fetchModules`: a page mounted inside this frame may have asked
    // already, and a second request would supersede the first.
    if (!moduleStore.loaded) void moduleStore.whenLoaded();
    try {
      const registry = await fetchAdminRegistry();
      ownScreens = new Set(
        registry
          .filter(
            (kon) =>
              kon.hasCustomView ||
              kon.views.some((view) => view.type === "custom" || view.type === "element")
          )
          .map((kon) => bare(kon.id))
      );
    } catch {
      /* the menu keeps the kons under Data */
    }
  });
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<CommandCenter
  bind:open={paletteOpen}
  {groups}
  {recent}
  {isAdmin}
  isStaff={staff}
  datasetsOn={isAdmin && moduleStore.activeKon("kon-datasets")}
/>

<AppShell
  breakpoint="lg"
  mainId="main-content"
  menuLabel={t("shell.openMenu")}
  navLabel={t("sidebarLayout.panel")}
  skipLabel={t("sidebarLayout.skipToContent")}
>
  {#snippet sidebar({ mobile, close })}
    <Sidebar
      groups={sidebarGroups(mobile ? close : undefined)}
      current={entry?.id}
      collapsible={!mobile}
      persistKey={mobile ? undefined : "kitsuden-sidebar-collapsed"}
      ariaLabel={mobile ? t("shell.navigationSheet") : t("sidebarLayout.panel")}
      collapseLabel={t("sidebarLayout.collapse")}
      expandLabel={t("sidebarLayout.expand")}
      icon={navIcon}
    >
      {#snippet header()}
        <a href="/" class="kitsuden-brand" onclick={mobile ? close : undefined}>
          <span class="kitsuden-brand-mark"><Sword size={16} aria-hidden="true" /></span>
          <span class="kitsuden-brand-name">{t("common.kitsuden")}</span>
        </a>
      {/snippet}

      {#snippet footer(isCollapsed: boolean)}
        <!--
          The modules did not arrive even after the store's retries: the menu is incomplete
          and that has to be said, with a way out that is not reloading the page.
        -->
        {#if isAdmin && moduleStore.error}
          <div class="kitsuden-modules-error" role="alert" data-testid="modules-error">
            {#if !isCollapsed}<p>{t("sidebarLayout.unloadedModules")}</p>{/if}
            <Button
              variant="outline"
              size={isCollapsed ? "icon" : "sm"}
              onclick={() => moduleStore.fetchModules()}
              disabled={moduleStore.loading}
              title={isCollapsed ? t("sidebarLayout.unloadedModules") : undefined}
              ariaLabel={isCollapsed ? t("common.retry") : undefined}
            >
              <RefreshCw size={14} class={moduleStore.loading ? "animate-spin" : ""} />
              {#if !isCollapsed}
                {moduleStore.loading ? t("common.retrying") : t("common.retry")}
              {/if}
            </Button>
          </div>
        {/if}
        {#if me}
          <UserMenu user={me} row collapsed={isCollapsed} />
        {/if}
      {/snippet}
    </Sidebar>
  {/snippet}

  {#snippet breadcrumb()}
    <Breadcrumb items={trail} ariaLabel={t("shell.breadcrumb")} />
  {/snippet}

  {#snippet command()}
    <Button
      variant="secondary"
      size="sm"
      ariaLabel={t("shell.searchOrCommand")}
      onclick={() => (paletteOpen = true)}
      data-testid="open-palette"
    >
      <Search size={14} aria-hidden="true" />
      <span class="kitsuden-command-text">{t("shell.search")}</span>
      <span class="kitsuden-command-keys"><Kbd keys={["Mod", "K"]} size="sm" /></span>
    </Button>
  {/snippet}

  {#snippet topbar()}
    {@const label =
      apiOnline === null
        ? t("shell.apiChecking")
        : apiOnline
          ? t("sidebarLayout.apiConnected")
          : t("sidebarLayout.apiOffline")}
    <Tooltip text={label}>
      {#snippet trigger(props)}
        <span
          {...props}
          class="kitsuden-api"
          class:kitsuden-api--on={apiOnline === true}
          class:kitsuden-api--off={apiOnline === false}
          role="status"
          tabindex="0"
          data-testid="api-status"
        >
          <span class="kitsuden-api-dot" aria-hidden="true"></span>
          <span class="sr-only">{label}</span>
        </span>
      {/snippet}
    </Tooltip>
  {/snippet}

  {#snippet user()}
    {#if me}<UserMenu user={me} />{/if}
  {/snippet}

  <!--
    Enabling a kon creates its tables on the fly, but its API routes are mounted at
    start-up. Without this notice the kon shows in the menu and each of its screens
    answers 404 without saying why. It lives in the frame because whoever enables a kon
    usually navigates right afterwards.
  -->
  {#if moduleStore.restartWarning}
    <div class="kitsuden-notice">
      <Alert
        variant="warning"
        onDismiss={() => (moduleStore.restartWarning = null)}
        dismissLabel={t("sidebarLayout.closeNotification")}
      >
        {moduleStore.restartWarning}
      </Alert>
    </div>
  {/if}

  {@render children?.()}
</AppShell>

{#snippet navIcon(item: SidebarItem)}
  <NavIcon name={entries.get(item.id)?.icon} />
{/snippet}

<style>
  .kitsuden-brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .kitsuden-brand:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
    border-radius: var(--ta-radius-sm);
  }
  .kitsuden-brand-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1.75rem;
    height: 1.75rem;
    color: rgb(var(--ta-accent));
    background: rgb(var(--ta-accent) / 0.1);
    border-radius: var(--ta-radius);
  }
  .kitsuden-brand-name {
    font-size: 0.875rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .kitsuden-modules-error {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-warning) / 0.1);
    border: 1px solid rgb(var(--ta-warning) / 0.3);
    border-radius: var(--ta-radius);
  }
  .kitsuden-modules-error p {
    margin: 0;
  }

  .kitsuden-api {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
  }
  .kitsuden-api:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 1px;
  }
  .kitsuden-api-dot {
    width: 0.5rem;
    height: 0.5rem;
    background: rgb(var(--ta-subtle));
    border-radius: 999px;
  }
  .kitsuden-api--on .kitsuden-api-dot {
    background: rgb(var(--ta-success));
  }
  .kitsuden-api--off .kitsuden-api-dot {
    background: rgb(var(--ta-danger));
  }

  /* The pending counter on the CURRENT entry sits on the accent tint: plain text there
     (the warning tone on that tint is 4.2:1 in the light theme). The dot keeps its colour. */
  :global(.ta-sidebar-item[aria-current="page"] .ta-sidebar-badge) {
    color: rgb(var(--ta-text));
  }

  .kitsuden-notice {
    margin-bottom: 1rem;
  }

  @media (max-width: 480px) {
    .kitsuden-command-text,
    .kitsuden-command-keys {
      display: none;
    }
  }
</style>
