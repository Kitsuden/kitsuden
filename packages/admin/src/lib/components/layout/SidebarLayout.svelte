<script lang="ts">
  import { t } from "$lib/i18n";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import {
    Sword,
    Gamepad2,
    Tv,
    FileText,
    Settings,
    Database,
    Workflow,
    ImageIcon,
    LogOut,
    Blocks,
    BookOpen,
    Book,
    Castle,
    Trophy,
    GraduationCap,
    FileStack,
    CalendarDays,
    Contact,
    PackageOpen,
    Zap,
    Bot,
    Archive,
    Brain,
    Briefcase,
    Landmark,
    RefreshCw,
    ShieldCheck,
    Plug,
    ServerCog,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  import { signOut, getUser, isAdmin as currentUserIsAdmin, isStaff } from "$lib/auth.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import KonIcon from "$lib/components/KonIcon.svelte";
  import { approvals } from "$lib/states/approvals.svelte";
  import { moduleStore } from "$lib/states/modules.svelte";
  import { Alert, Avatar, Button, Sidebar, type SidebarGroup, type SidebarItem } from "$lib/tallao";

  import GlobalSearch from "./GlobalSearch.svelte";
  import CurrentUser from "./CurrentUser.svelte";

  import { page } from "$app/stores";

  let collapsed = $state(false);
  let apiOnline = $state(false);

  const user = $derived(getUser());

  // Get current path from SvelteKit
  const currentPath = $derived($page.url.pathname);

  // Map nav items to their module keys (null = always show)
  interface NavItem {
    path: string;
    label: string;
    icon: any; // Lucide-svelte types can conflict with base Svelte 5 types
    /** Name or glyph declared by the kon. If present, it takes precedence over `icon`. */
    iconName?: string;
    moduleKey?: string; // If set, only show when this module is enabled
    order?: number; // Lower = higher in the list (0 = first after dashboard)
    category?: "core" | "optional" | "grimoire"; // For grouping
    /** An editor sees it too (the API opens it to the team). */
    staff?: boolean;
  }

  // Navigation items organized by category and order
  //
  // ORDERING RULES:
  // 1. Dashboard is always first (order: undefined, hardcoded first)
  // 2. DataSets (kon-datasets) is ALWAYS second when enabled (order: 0)
  // 3. Other Core kons follow (order: 1, 2, 3...)
  // 4. Optional kons come after Core (order: 10, 11, 12...)
  // 5. Grimoire kons come last (order: 20, 21, 22...)
  //
  // This ensures DataSets maintains its position even when toggled on/off
  //
  // NOTE: Formulas/KPIs are part of DataSets (calculated fields).
  // NOTE: Connectors are part of Settings > Integrations.
  // NOTE: Webhooks/Workers are part of Actions (Engine level).
  // ═══════════════════════════════════════════════════════════════════════
  // DYNAMIC NAVIGATION: 100% dynamic admin
  // All kon routes now use the dynamic /g/[grimoireId] path.
  // The GrimoirePage component renders views generically from grimoire.json.
  // Legacy static routes (/games, /blog, etc.) redirect to /g/[grimoireId].
  // ═══════════════════════════════════════════════════════════════════════

  const allNavItems: NavItem[] = [
    // ═══ DASHBOARD (Always first) ═══
    { path: "/", label: t("common.dashboard"), icon: BookOpen },

    // ═══ CORE KONS (Always shown first, can be toggled) ═══
    {
      path: "/g/kon-datasets",
      label: t("sidebarLayout.datasets"),
      icon: Database,
      moduleKey: "kon-datasets",
      order: 0,
      category: "core",
    },
    {
      path: "/g/kon-media",
      label: t("sidebarLayout.mediaLibrary"),
      icon: ImageIcon,
      moduleKey: "kon-media",
      order: 1,
      category: "core",
    },
    {
      path: "/g/kon-blocks",
      label: t("sidebarLayout.pageBuilder"),
      icon: Blocks,
      moduleKey: "kon-blocks",
      order: 2,
      category: "core",
    },
    {
      path: "/g/kon-blog",
      label: t("common.blogPosts"),
      icon: FileText,
      moduleKey: "kon-blog",
      order: 3,
      category: "core",
    },

    // ═══ OPTIONAL KONS (order: 10+) ═══
    {
      path: "/g/kon-academy-lms",
      label: t("sidebarLayout.academy"),
      icon: GraduationCap,
      moduleKey: "kon-academy-lms",
      order: 10,
      category: "optional",
    },
    {
      path: "/g/kon-dms",
      label: t("sidebarLayout.documents"),
      icon: FileStack,
      moduleKey: "kon-dms",
      order: 12,
      category: "optional",
    },
    {
      path: "/g/kon-booking",
      label: t("sidebarLayout.booking"),
      icon: CalendarDays,
      moduleKey: "kon-booking",
      order: 13,
      category: "optional",
    },
    {
      path: "/g/kon-directory",
      label: t("sidebarLayout.directory"),
      icon: Contact,
      moduleKey: "kon-directory",
      order: 14,
      category: "optional",
    },
    {
      path: "/g/kon-crm",
      label: t("sidebarLayout.kitsudenCrm"),
      icon: Briefcase,
      moduleKey: "kon-crm",
      order: 15,
      category: "optional",
    },
    {
      path: "/g/kon-conta",
      label: t("sidebarLayout.accounting"),
      icon: Landmark,
      moduleKey: "kon-conta",
      order: 16,
      category: "optional",
    },

    // ═══ GRIMOIRE KONS (Esports/Gaming) (order: 20+) ═══
    {
      path: "/g/kon-games",
      label: t("common.games"),
      icon: Gamepad2,
      moduleKey: "kon-games",
      order: 20,
      category: "grimoire",
    },
    {
      path: "/g/kon-streamers",
      label: t("common.streamers"),
      icon: Tv,
      moduleKey: "kon-streamers",
      order: 21,
      category: "grimoire",
    },
    {
      path: "/g/kon-esports",
      label: t("sidebarLayout.esports"),
      icon: Trophy,
      moduleKey: "kon-esports",
      order: 22,
      category: "grimoire",
    },
  ];

  const bottomNavItems: NavItem[] = [
    { path: "/kons", label: t("sidebarLayout.kons"), icon: Book },
    { path: "/grimoires", label: t("sidebarLayout.grimoires"), icon: Castle },
    { path: "/actions", label: t("common.actions"), icon: Zap },
    { path: "/brain", label: t("sidebarLayout.kitsudenBrain"), icon: Brain },
    { path: "/vault", label: t("sidebarLayout.kitsudenVault"), icon: Archive },
    { path: "/agents", label: t("sidebarLayout.aiAgents"), icon: Bot },
    // Human approval inbox (with the pending counter)
    { path: "/approvals", label: t("sidebarLayout.approvals"), icon: ShieldCheck, staff: true },
    // OAuth for MCP: connected clients and their revocation (docs/agents/oauth.md)
    {
      path: "/oauth/connections",
      label: t("sidebarLayout.oauthConnections"),
      icon: Plug,
      staff: true,
    },
    // External MCP servers: tool fingerprints and their human review (admin only)
    { path: "/mcp-servers", label: t("sidebarLayout.externalMcpServers"), icon: ServerCog },
    // Views generated from models (defineModel)
    { path: "/models", label: t("sidebarLayout.models"), icon: Database, staff: true },
    // The «glass box» of requests and the Postgres queue (admin only)
    { path: "/traces", label: t("sidebarLayout.systemTraces"), icon: Workflow },
    { path: "/settings", label: t("common.settings"), icon: Settings },
  ];

  // Keys already in the hardcoded nav (don't duplicate from filesystem scan)
  const hardcodedModuleKeys = new Set(
    allNavItems.filter((n) => n.moduleKey).map((n) => n.moduleKey!)
  );

  // ═══ DYNAMIC NAV — any enabled kon that is not curated above ═══
  // Covers: kons auto-discovered from the filesystem, kons installed via
  // npm/marketplace, and kons contributed by the active grimoire. A newly
  // activated kon appears here without touching this file (zero-config).
  // Core infrastructure (webhooks, connectors, ai-memories) is excluded,
  // which lives in Settings/Actions according to the rules above.
  const CORE_INFRA_KEYS = new Set([
    "webhooks",
    "kon-webhooks",
    "connectors",
    "kon-connectors",
    "ai-memories",
  ]);

  const dynamicNavItems = $derived(
    moduleStore.modules
      .filter(
        (m) =>
          moduleStore.activeKon(m.key) &&
          !hardcodedModuleKeys.has(m.key) &&
          !CORE_INFRA_KEYS.has(m.key) &&
          (m.key.startsWith("kon-") || m.source === "filesystem" || m.source === "grimoire")
      )
      .map((m) => ({
        path: `/g/${m.key}`,
        label: m.name || m.key.replace(/^kon-/, ""),
        // The icon comes from the kon's manifest, not fixed.
        //
        // This was `PackageOpen` for ALL of them: the menu showed the same box on
        // every entry and one kon could not be told from another at a glance.
        //
        // The NAME is stored and not the already-resolved component because the value
        // may be an emoji («🖼️») instead of a lucide name («Tv»): the core
        // modules use one convention and the filesystem kons
        // the other. Resolving here would force choosing one and breaking the
        // other; `KonIcon` understands both.
        icon: PackageOpen,
        iconName: m.icon,
        moduleKey: m.key,
        order: 50,
        category: (m.category === "grimoire" ? "grimoire" : "optional") as NavItem["category"],
      }))
  );

  /**
   * The editor cannot read /api/modules (it is admin-only), so it does not know which kons
   * are active. It sees what the API lets it touch as «staff»: media, pages and
   * blog (apps/api/src/middleware/auth-guard.ts). Without this its menu was left at
   * «Dashboard» and a system section where everything returned 403.
   */
  const EDITOR_KEYS = new Set(["kon-media", "kon-blocks", "kon-blog"]);
  const isAdmin = $derived(currentUserIsAdmin());

  // Filter nav items based on enabled modules from shared store
  // Then sort by order to maintain consistent positioning
  const visibleNavItems = $derived(
    [
      // By kon, not by string: an entry declared as `blog` disappeared
      // even though what was on was `kon-blog`. And a disabled kon —or one that no longer
      // exists, which does not even arrive in `modules`— stops having a link.
      ...allNavItems.filter(
        (item) =>
          !item.moduleKey ||
          (isAdmin ? moduleStore.activeKon(item.moduleKey) : EDITOR_KEYS.has(item.moduleKey))
      ),
      ...dynamicNavItems,
    ].sort((a, b) => {
      // Dashboard (no order) always comes first
      if (a.path === "/") return -1;
      if (b.path === "/") return 1;

      // Then sort by order (undefined order goes to end)
      const orderA = a.order ?? 999;
      const orderB = b.order ?? 999;
      return orderA - orderB;
    })
  );

  const visibleBottomItems = $derived(
    isAdmin
      ? bottomNavItems.filter((item) => !item.moduleKey || moduleStore.activeKon(item.moduleKey))
      : isStaff()
        ? bottomNavItems.filter((item) => item.staff)
        : []
  );

  async function handleLogout() {
    // Wait for the close: without `await`, the reload happened before the request and
    // the panel was painted again with the session still alive (and then everything gave 401).
    await signOut();
    // `/login` is not a route: the layout shows the form when there is no
    // session. Sending there gave a 404 on logout.
    window.location.href = "/";
  }

  function isActive(path: string): boolean {
    if (path === "/") return currentPath === "/";
    return currentPath.startsWith(path);
  }

  /** Every visible entry by its path (the Sidebar item's id), to draw its icon. */
  const NAV_BY_PATH = $derived(
    new Map([...visibleNavItems, ...visibleBottomItems].map((n) => [n.path, n]))
  );

  /**
   * The Sidebar marks the entry whose href equals `current`. A sub-page
   * (/settings/x, /g/kon-blog/posts) keeps its section lit: the longest matching path.
   */
  const currentNavPath = $derived(
    [...visibleNavItems, ...visibleBottomItems]
      .filter((n) => isActive(n.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path
  );

  const toItem = (n: NavItem): SidebarItem => {
    const pending = n.path === "/approvals" ? approvals.pendingItems : 0;
    return {
      id: n.path,
      label: n.label,
      href: n.path,
      ...(pending > 0
        ? { badge: pending, badgeVariant: "warning" as const, badgePulse: true }
        : {}),
    };
  };

  const navGroups = $derived<SidebarGroup[]>([
    { items: visibleNavItems.map(toItem) },
    ...(visibleBottomItems.length > 0
      ? [{ label: t("common.system"), items: visibleBottomItems.map(toItem) }]
      : []),
  ]);

  /** Only http(s) images or the API's own routes, as in CurrentUser. */
  const userAvatar = $derived.by(() => {
    const img = user?.image?.trim();
    if (!img) return null;
    if (/^https?:\/\//i.test(img)) return img;
    if (img.startsWith("/") && !img.startsWith("//"))
      return `${import.meta.env.VITE_API_URL ?? ""}${img}`;
    return null;
  });

  // The pending proposals counter, for whoever can decide them.
  onMount(() => (isStaff() ? approvals.watch() : undefined));

  onMount(async () => {
    const API = import.meta.env.VITE_API_URL ?? "";

    // Check API health
    try {
      const res = await fetch(`${API}/api/health`);
      apiOnline = res.ok;
      // Only the status matters. The body was never read, so the connection stayed open
      // until it was collected (and the dev tools showed the request as pending).
      void res.body?.cancel().catch(() => {});
    } catch {
      apiOnline = false;
    }

    // Fetch modules into shared store (if not already loaded)
    if (!moduleStore.loaded && currentUserIsAdmin()) {
      // `whenLoaded`, not `fetchModules`: a page mounted inside this layout (the post
      // editor) may have asked already, and a second request would supersede the first.
      await moduleStore.whenLoaded();
    }
  });

  // Slot content
  const { children }: { children?: import("svelte").Snippet } = $props();
</script>

<CommandPalette navItems={visibleNavItems} bottomNavItems={visibleBottomItems} />

<div class="flex h-screen overflow-hidden">
  <!--
    tallao's Sidebar: groups, the current route (aria-current), collapse remembered in
    localStorage, a Tooltip per item while collapsed, and the pending-approvals counter as a
    pulsing badge. What it has no place for (the unloaded-modules notice, the user and
    sign-out) goes in its footer, which knows whether the bar is collapsed.
  -->
  <div class="h-full shrink-0 bg-kitsuden-card">
    <Sidebar
      groups={navGroups}
      current={currentNavPath}
      bind:collapsed
      persistKey="kitsuden-sidebar-collapsed"
      ariaLabel={t("sidebarLayout.panel")}
      collapseLabel={t("sidebarLayout.collapse")}
      expandLabel={t("sidebarLayout.expand")}
      icon={navIcon}
    >
      {#snippet header()}
        <div class="flex items-center gap-2 overflow-hidden">
          <div
            class="w-7 h-7 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center shrink-0"
          >
            <Sword class="w-4 h-4 text-kitsuden-accent" />
          </div>
          <span class="font-semibold text-sm tracking-tight whitespace-nowrap">
            {t("common.kitsuden")}
          </span>
        </div>
      {/snippet}

      {#snippet footer(isCollapsed: boolean)}
        <!--
          The modules did not arrive even after `fetchModules` retries: the
          menu is incomplete and that has to be said, with a way out that is not
          reloading the whole page.
        -->
        {#if isAdmin && moduleStore.error}
          <div
            class="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-kitsuden-text {isCollapsed
              ? 'p-1 flex justify-center'
              : 'px-3 py-2'}"
            role="alert"
            data-testid="modules-error"
          >
            {#if !isCollapsed}
              <p class="mb-2">{t("sidebarLayout.unloadedModules")}</p>
            {/if}
            <Button
              variant="outline"
              size={isCollapsed ? "icon" : "sm"}
              onclick={() => moduleStore.fetchModules()}
              disabled={moduleStore.loading}
              title={isCollapsed ? t("sidebarLayout.unloadedModules") : undefined}
              ariaLabel={isCollapsed ? t("sidebarLayout.reintentar") : undefined}
            >
              <RefreshCw class="w-3.5 h-3.5 {moduleStore.loading ? 'animate-spin' : ''}" />
              {#if !isCollapsed}
                {moduleStore.loading
                  ? t("sidebarLayout.reintentando")
                  : t("sidebarLayout.reintentar")}
              {/if}
            </Button>
          </div>
        {/if}
        {#if user}
          <div
            class="flex items-center min-w-0 {isCollapsed ? 'justify-center' : 'gap-2 px-1'}"
            data-testid="sidebar-user"
          >
            <Avatar
              name={user.name || user.email || "?"}
              src={userAvatar}
              size="sm"
              decorative={!isCollapsed}
              title={isCollapsed ? `${user.name ?? ""} (${user.email ?? ""})` : undefined}
            />
            {#if !isCollapsed}
              <div class="flex-1 min-w-0">
                <p class="text-xs font-medium text-kitsuden-text truncate">{user.name}</p>
                <p class="text-[10px] text-kitsuden-subtle truncate">{user.email}</p>
              </div>
              <Button
                variant="danger-ghost"
                size="icon"
                onclick={handleLogout}
                title={t("sidebarLayout.signOut")}
                ariaLabel={t("sidebarLayout.signOut")}
              >
                <LogOut class="w-3.5 h-3.5" />
              </Button>
            {/if}
          </div>
        {/if}
      {/snippet}
    </Sidebar>
  </div>

  {#snippet navIcon(item: SidebarItem)}
    {@const nav = NAV_BY_PATH.get(item.id)}
    {#if nav?.iconName}
      <KonIcon name={nav.iconName} size={16} class="shrink-0" />
    {:else if nav}
      {@const Icon = nav.icon}
      <Icon class="w-4 h-4 shrink-0" />
    {/if}
  {/snippet}

  <!-- Main Content -->
  <main class="flex-1 overflow-y-auto bg-kitsuden-bg">
    <!-- Top bar -->
    <header
      class="sticky top-0 z-30 flex items-center justify-between h-14 px-6 border-b border-kitsuden-border"
    >
      <!--
        Progressive blur: the same pattern as the sites' header — three
        backdrop-filter layers with stepped masks and a theme tint.
        Before it was a flat bg/80 blur; now the blur falls off
        as a feather toward the bottom edge.
      -->
      <div class="blur-topbar" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="flex items-center gap-4 flex-1 min-w-0">
        <h1 class="text-sm font-semibold text-kitsuden-text shrink-0">
          {t("sidebarLayout.panel")}
        </h1>
        <GlobalSearch
          navItems={visibleNavItems}
          bottomNavItems={visibleBottomItems}
          filesystemNavItems={dynamicNavItems}
        />
      </div>
      <div class="flex items-center gap-3 shrink-0 ml-4">
        <LanguageSwitcher />
        <div
          class="flex items-center gap-2 text-xs {apiOnline
            ? 'text-kitsuden-green'
            : 'text-kitsuden-accent-2'}"
        >
          <span
            class="w-2 h-2 rounded-full {apiOnline
              ? 'bg-kitsuden-green animate-pulse'
              : 'bg-kitsuden-subtle'}"
          ></span>
          {apiOnline ? t("sidebarLayout.apiConnected") : t("sidebarLayout.apiOffline")}
        </div>
        {#if user}
          <CurrentUser {user} />
        {/if}
      </div>
    </header>

    <!--
      Pending restart notice.

      Enabling a kon creates its tables on the fly, but its API routes are
      mounted at startup (Hono does not support `app.route()` after the first
      request). Without this notice the kon appears in the menu and each of its screens
      returns 404 without saying why.

      It goes in the layout and not next to the switch because whoever enables a kon
      usually navigates right afterwards; there the notice would have been lost.
    -->
    {#if moduleStore.restartWarning}
      <div class="mx-6 mt-6">
        <Alert
          variant="warning"
          onDismiss={() => (moduleStore.restartWarning = null)}
          dismissLabel={t("sidebarLayout.closeNotification")}
        >
          {moduleStore.restartWarning}
        </Alert>
      </div>
    {/if}

    <!-- Page content -->
    <div class="p-6">
      {@render children?.()}
    </div>
  </main>
</div>

<style>
  /* ── Progressive blur of the top bar ───────────────────────────────────── */
  .blur-topbar {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(
      180deg,
      rgb(var(--kitsuden-bg) / 0.82),
      rgb(var(--kitsuden-bg) / 0.6)
    );
  }
  .blur-topbar span {
    position: absolute;
    inset: 0;
  }
  /* More blur at the top, feathering to the bottom edge */
  .blur-topbar span:nth-child(1) {
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    -webkit-mask-image: linear-gradient(180deg, #000 0%, transparent 45%);
    mask-image: linear-gradient(180deg, #000 0%, transparent 45%);
  }
  .blur-topbar span:nth-child(2) {
    -webkit-backdrop-filter: blur(7px);
    backdrop-filter: blur(7px);
    -webkit-mask-image: linear-gradient(180deg, #000 0%, transparent 75%);
    mask-image: linear-gradient(180deg, #000 0%, transparent 75%);
  }
  .blur-topbar span:nth-child(3) {
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
    -webkit-mask-image: linear-gradient(180deg, #000 30%, transparent 100%);
    mask-image: linear-gradient(180deg, #000 30%, transparent 100%);
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .blur-topbar {
      background: rgb(var(--kitsuden-bg) / 0.97);
    }
  }
</style>
