<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  /**
   * Dashboard.svelte - Professional Dashboard with Empty States
   *
   * Shows real-time stats from core grimoires with professional empty states
   */
  import {
    LayoutDashboard,
    Users,
    Activity,
    Zap,
    PenTool,
    Image,
    Database,
    FileText,
    Layers,
    Blocks,
    Sparkles,
    Inbox,
    Plus,
    ArrowRight,
    Clock,
    ChevronRight,
  } from "lucide-svelte";
  import { onMount } from "svelte";
  import type { ComponentType, SvelteComponent } from "svelte";

  import { isAdmin } from "../lib/auth.svelte";
  import { activityLabel, newestFirst } from "../lib/dashboard-activity";
  import StatusBadge from "../lib/components/ui/StatusBadge.svelte";
  import { Badge, Button } from "../lib/tallao";
  import { componentRegistry } from "../lib/registry.svelte";
  import WidgetSlot from "../lib/WidgetSlot.svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  // Icon component type (lucide icons)
  type IconComponent = ComponentType<SvelteComponent<{ class?: string }>>;

  // Stats state
  type StatItem = {
    label: string;
    value: string | number;
    icon: IconComponent;
    color: string;
    hasData: boolean;
    href?: string;
  };

  type ActivityItem = {
    icon: IconComponent;
    color: string;
    text: string;
    time: string;
    /** When it happened, as the API sent it: the list is sorted by this, not by `time`. */
    at: string;
    href?: string;
  };

  let stats = $state<StatItem[]>([]);
  let loadingStats = $state(true);

  // Activity state
  let recentActivity = $state<ActivityItem[]>([]);
  let loadingActivity = $state(true);

  // Grimoires state
  let enabledModules = $state<string[]>([]);
  let loadingModules = $state(true);

  // Define default stat cards (always shown)
  type DefaultStat = Omit<StatItem, "value" | "hasData"> & { key: string };

  const defaultStats: DefaultStat[] = [
    {
      key: "users",
      label: t("dashboard.users"),
      icon: Users,
      color: "cyan",
      /**
       * NO link, on purpose.
       *
       * This counter has led to two wrong places. First to `/users`,
       * which does not exist (404). Later it was pointed to `/data-viewer`, which is worse:
       * that screen calls SIX endpoints under `/api/data-visualizer/*` and
       * NONE exists in the API, so it stays empty swallowing the error.
       *
       * The panel has no users screen. Until it has one, the
       * number is shown and that is it: an honest figure is better than a link that
       * promises one screen and delivers another.
       */
    },
    {
      key: "posts",
      label: t("dashboard.posts"),
      icon: FileText,
      color: "green",
      href: "/g/kon-blog",
    },
    {
      key: "datasets",
      label: t("common.datasets"),
      icon: Database,
      color: "amber",
      href: "/datasets",
    },
    { key: "media", label: t("common.media"), icon: Image, color: "purple", href: "/g/kon-media" },
  ];

  onMount(async () => {
    await Promise.all([loadStats(), loadRecentActivity(), loadEnabledModules()]);
  });

  async function loadStats() {
    loadingStats = true;
    try {
      const results = await Promise.allSettled([
        fetch(`${API_URL}/api/users/count`, { credentials: "include" }),
        fetch(`${API_URL}/api/blog/posts/count`, { credentials: "include" }),
        fetch(`${API_URL}/api/datasets/count`, { credentials: "include" }),
        fetch(`${API_URL}/api/media/count`, { credentials: "include" }),
      ]);

      const newStats: StatItem[] = [];

      for (let i = 0; i < defaultStats.length; i++) {
        const stat = defaultStats[i];
        const res = results[i];
        let value: string | number = "—";
        let hasData = false;

        if (res.status === "fulfilled" && res.value.ok) {
          try {
            const data = await res.value.json();
            if (data && typeof data.count === "number") {
              value = formatNumber(data.count);
              hasData = data.count > 0;
            }
          } catch (e) {
            // Keep default "—" value
          }
        }

        newStats.push({
          ...stat,
          value,
          hasData,
        });
      }

      stats = newStats;
    } catch (err) {
      console.error("Failed to load stats:", err);
      // Show empty stats on error
      stats = defaultStats.map((s) => ({ ...s, value: "—", hasData: false }));
    } finally {
      loadingStats = false;
    }
  }

  async function loadRecentActivity() {
    loadingActivity = true;
    try {
      // Agent and action logs are admin-only: the editor was just getting a 403.
      const admin = isAdmin();
      const skipped = Promise.resolve(new Response(null, { status: 204 }));
      const [auditRes, actionsRes, datasetsRes] = await Promise.allSettled([
        admin
          ? fetch(`${API_URL}/api/admin/agents/logs?limit=5`, { credentials: "include" })
          : skipped,
        admin ? fetch(`${API_URL}/api/actions?limit=5`, { credentials: "include" }) : skipped,
        fetch(`${API_URL}/api/datasets?limit=5&orderBy=createdAt&order=desc`, {
          credentials: "include",
        }),
      ]);

      const activities: ActivityItem[] = [];

      if (auditRes.status === "fulfilled" && auditRes.value.status === 200) {
        const data = await auditRes.value.json();
        if (data.success && Array.isArray(data.data) && data.data.length > 0) {
          activities.push(
            ...data.data.slice(0, 3).map((log: any) => ({
              icon: Activity,
              color: log.success ? "cyan" : "pink",
              text: activityLabel(log.action, t),
              time: formatTimeAgo(log.createdAt),
              at: log.createdAt,
              // `/agents/logs` is NOT a route: it matches `/agents/[id]` and opens the page
              // of an agent called "logs", which does not exist. It resolved in the link
              // probe for that very reason, and failed just the same on click.
              href: `/agents/traces`,
            }))
          );
        }
      }

      if (actionsRes.status === "fulfilled" && actionsRes.value.status === 200) {
        const data = await actionsRes.value.json();
        if (Array.isArray(data.docs) && data.docs.length > 0) {
          activities.push(
            ...data.docs.slice(0, 3).map((action: any) => ({
              icon: Zap,
              color: action.status === "active" ? "green" : "subtle",
              text: t("dashboard.action", { status: action.status, name: action.name }),
              time: formatTimeAgo(action.createdAt),
              at: action.createdAt,
              href: `/actions`,
            }))
          );
        }
      }

      if (datasetsRes.status === "fulfilled" && datasetsRes.value.ok) {
        const data = await datasetsRes.value.json();
        if (Array.isArray(data.docs) && data.docs.length > 0) {
          activities.push(
            ...data.docs.slice(0, 3).map((ds: any) => ({
              icon: Database,
              color: "amber",
              text: t("dashboard.datasetCreated", { name: ds.name }),
              time: formatTimeAgo(ds.createdAt),
              at: ds.createdAt,
              href: `/datasets`,
            }))
          );
        }
      }

      // Most recent first, by the real moment (see `$lib/dashboard-activity`).
      recentActivity = newestFirst(activities).slice(0, 6);
    } catch (err) {
      console.error("Failed to load activity:", err);
      recentActivity = [];
    } finally {
      loadingActivity = false;
    }
  }

  async function loadEnabledModules() {
    loadingModules = true;
    if (!isAdmin()) {
      // /api/modules is admin-only; the editor has nothing to count here.
      loadingModules = false;
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/modules`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        // The API responds `docs` (as states/modules.svelte.ts reads it); reading
        // `modules` left "Active grimoires" at 0 always.
        const list: any[] = data.docs ?? data.modules ?? [];
        const enabled = list.filter((m) => m.enabled !== false).map((m) => m.key ?? m.id);
        enabledModules = enabled;
        componentRegistry.setEnabledModules(enabled);
      }
    } catch {
      enabledModules = [];
    } finally {
      loadingModules = false;
    }
  }

  function formatNumber(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return n.toString();
  }

  function formatTimeAgo(date: string): string {
    if (!date) return "";
    const now = new Date();
    const then = new Date(date);
    const diff = now.getTime() - then.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  // Quick actions configuration
  const quickActions = [
    {
      label: t("common.newPost"),
      href: "/g/kon-blog",
      icon: PenTool,
      color: "green",
      description: t("dashboard.createABlogPost"),
    },
    {
      label: t("dashboard.newDataset"),
      href: "/datasets/new",
      icon: Database,
      color: "amber",
      description: t("dashboard.createDataCollection"),
    },
    {
      label: t("dashboard.newPage"),
      href: "/g/kon-blocks",
      icon: Blocks,
      color: "pink",
      description: t("dashboard.buildAPage"),
    },
    {
      label: t("dashboard.uploadMedia"),
      href: "/g/kon-media",
      icon: Image,
      color: "purple",
      description: t("dashboard.addFiles"),
    },
  ];

  // Core grimoires for sidebar
  const coreGrimoires = [
    {
      id: "datasets",
      label: t("common.datasets"),
      description: t("dashboard.dataCollections"),
      icon: Database,
      color: "amber",
      href: "/datasets",
    },
    {
      id: "blog",
      label: t("dashboard.blog"),
      description: t("dashboard.postsArticles"),
      icon: FileText,
      color: "green",
      href: "/g/kon-blog",
    },
    {
      id: "pages",
      label: t("dashboard.pages"),
      description: t("dashboard.pageBuilder"),
      icon: Blocks,
      color: "pink",
      href: "/g/kon-blocks",
    },
    {
      id: "media",
      label: t("common.media"),
      description: t("dashboard.fileLibrary"),
      icon: Image,
      color: "purple",
      href: "/g/kon-media",
    },
    {
      id: "actions",
      label: t("common.actions"),
      description: t("dashboard.automations"),
      icon: Zap,
      color: "cyan",
      href: "/actions",
    },
  ];

  // Helper function to get border color class
  function getBorderHoverClass(color: string): string {
    const map: Record<string, string> = {
      cyan: "hover:border-kitsuden-accent/30",
      green: "hover:border-green-500/30",
      amber: "hover:border-amber-500/30",
      purple: "hover:border-purple-500/30",
      pink: "hover:border-pink-500/30",
    };
    return map[color] || "";
  }

  // Helper function to get text hover class
  function getTextHoverClass(color: string): string {
    const map: Record<string, string> = {
      cyan: "group-hover:text-kitsuden-accent",
      green: "group-hover:text-kitsuden-green",
      amber: "group-hover:text-kitsuden-amber",
      purple: "group-hover:text-kitsuden-purple",
      pink: "group-hover:text-kitsuden-accent-2",
      subtle: "group-hover:text-kitsuden-subtle",
    };
    return map[color] || "";
  }

  // Helper function to get background class
  function getBgClass(color: string): string {
    const map: Record<string, string> = {
      cyan: "bg-kitsuden-accent/10",
      green: "bg-kitsuden-green/10",
      amber: "bg-kitsuden-amber/10",
      purple: "bg-kitsuden-purple/10",
      pink: "bg-kitsuden-accent-2/10",
      subtle: "bg-kitsuden-subtle/10",
    };
    return map[color] || "";
  }

  // Helper function to get text color class
  function getTextClass(color: string): string {
    const map: Record<string, string> = {
      cyan: "text-kitsuden-accent",
      green: "text-kitsuden-green",
      amber: "text-kitsuden-amber",
      purple: "text-kitsuden-purple",
      pink: "text-kitsuden-accent-2",
      subtle: "text-kitsuden-subtle",
    };
    return map[color] || "";
  }
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-accent/20 to-kitsuden-purple/20 border border-kitsuden-accent/20 flex items-center justify-center"
        >
          <LayoutDashboard class="w-5 h-5 text-kitsuden-accent" />
        </div>
        {t("common.dashboard")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">{t("dashboard.overviewOfYourKitsudenCms")}</p>
    </div>
    <div class="flex items-center gap-2">
      <Badge>
        {new Date().toLocaleDateString(localeFormat(), {
          weekday: "long",
          month: "short",
          day: "numeric",
        })}
      </Badge>
    </div>
  </div>

  <!-- Stats Grid - Always visible -->
  <section>
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-medium text-kitsuden-subtle uppercase tracking-wider">
        {t("dashboard.overview")}
      </h2>
      {#if !loadingStats}
        <Button variant="ghost" size="sm" onclick={loadStats}>
          <Clock class="w-3 h-3" />
          {t("dashboard.refresh")}
        </Button>
      {/if}
    </div>

    {#if loadingStats}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {#each [1, 2, 3, 4] as i}
          <div class="card p-4 animate-pulse">
            <div class="flex items-start justify-between">
              <div class="space-y-2">
                <div class="h-3 w-16 bg-kitsuden-bg rounded-sm"></div>
                <div class="h-8 w-12 bg-kitsuden-bg rounded-sm"></div>
              </div>
              <div class="w-10 h-10 rounded-lg bg-kitsuden-bg"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {#each stats as stat}
          <!--
            Without a destination, it is not a link.

            It used to be `href={stat.href || "#"}`: the card looked and behaved
            as clickable and led nowhere. A `#` is a link that
            lies. With `svelte:element` the card is an `<a>` only when there
            really is somewhere to go.
          -->
          <svelte:element
            this={stat.href ? "a" : "div"}
            href={stat.href}
            class="card p-4 transition-all hover:shadow-lg group {getBorderHoverClass(stat.color)}"
            class:opacity-60={!stat.hasData}
            class:cursor-default={!stat.href}
          >
            <div class="flex items-start justify-between">
              <div>
                <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">{stat.label}</p>
                <p
                  class="text-2xl font-bold text-kitsuden-text mt-1 {getTextHoverClass(stat.color)}"
                >
                  {stat.value}
                </p>
                {#if !stat.hasData}
                  <p class="text-xs text-kitsuden-subtle/60 mt-1">{t("dashboard.noData")}</p>
                {/if}
              </div>
              <div
                class="w-10 h-10 rounded-lg {getBgClass(
                  stat.color
                )} flex items-center justify-center group-hover:scale-110 transition-transform"
              >
                <stat.icon class="w-5 h-5 {getTextClass(stat.color)}" />
              </div>
            </div>
          </svelte:element>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Main Content Grid -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Left Column (2/3) -->
    <div class="lg:col-span-2 space-y-6">
      <!-- Recent Activity -->
      <section class="card">
        <div class="p-4 border-b border-kitsuden-border flex items-center justify-between">
          <h3 class="font-semibold text-kitsuden-text flex items-center gap-2">
            <Activity class="w-4 h-4 text-kitsuden-accent" />
            {t("dashboard.recentActivity")}
          </h3>
          {#if recentActivity.length > 0}
            <a
              href="/actions"
              class="text-xs text-kitsuden-accent hover:underline flex items-center gap-1"
            >
              {t("dashboard.viewAll")}
              <ChevronRight class="w-3 h-3" />
            </a>
          {/if}
        </div>

        <div class="p-4">
          {#if loadingActivity}
            <div class="space-y-4">
              {#each [1, 2, 3] as i}
                <div class="flex items-center gap-3 animate-pulse">
                  <div class="w-8 h-8 rounded-full bg-kitsuden-bg"></div>
                  <div class="flex-1 space-y-2">
                    <div class="h-4 bg-kitsuden-bg rounded-sm w-3/4"></div>
                    <div class="h-3 bg-kitsuden-bg rounded-sm w-1/4"></div>
                  </div>
                </div>
              {/each}
            </div>
          {:else if recentActivity.length > 0}
            <div class="space-y-3">
              {#each recentActivity as activity}
                <a
                  href={activity.href || "#"}
                  class="flex items-center gap-3 p-2 rounded-lg hover:bg-kitsuden-bg/50 transition-colors group"
                >
                  <div
                    class="w-8 h-8 rounded-full {getBgClass(
                      activity.color
                    )} flex items-center justify-center shrink-0"
                  >
                    <activity.icon class="w-4 h-4 {getTextClass(activity.color)}" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <p
                      class="text-sm text-kitsuden-text truncate group-hover:text-kitsuden-accent transition-colors"
                    >
                      {activity.text}
                    </p>
                    <p class="text-xs text-kitsuden-subtle">{activity.time}</p>
                  </div>
                  <ChevronRight
                    class="w-4 h-4 text-kitsuden-subtle opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </a>
              {/each}
            </div>
          {:else}
            <!-- Empty State -->
            <div class="text-center py-8">
              <div
                class="w-16 h-16 mx-auto mb-4 rounded-full bg-kitsuden-bg flex items-center justify-center"
              >
                <Inbox class="w-8 h-8 text-kitsuden-subtle" />
              </div>
              <h4 class="text-sm font-medium text-kitsuden-text mb-1">
                {t("dashboard.noRecentActivity")}
              </h4>
              <p class="text-xs text-kitsuden-subtle mb-4">
                {t("dashboard.startCreatingContentToSee")}
              </p>
              <div class="flex items-center justify-center gap-2">
                <Button href="/content/edit?collection=blog-posts" size="sm">
                  <Plus class="w-3 h-3" />
                  {t("dashboard.createPost")}
                </Button>
              </div>
            </div>
          {/if}
        </div>
      </section>

      <!-- Widget Slot: Content -->
      <WidgetSlot name="dashboard:content" wrapper="card" class="space-y-4" />
    </div>

    <!-- Right Column (1/3) -->
    <div class="space-y-6">
      <!-- Quick Actions -->
      <section class="card p-4">
        <h3 class="font-semibold text-kitsuden-text mb-4 flex items-center gap-2">
          <Zap class="w-4 h-4 text-kitsuden-accent" />
          {t("dashboard.quickActions")}
        </h3>
        <div class="space-y-2">
          {#each quickActions as action}
            <a
              href={action.href}
              class="group flex items-center gap-3 p-3 rounded-lg hover:bg-kitsuden-bg transition-all border border-transparent {getBorderHoverClass(
                action.color
              )}"
            >
              <div
                class="w-10 h-10 rounded-lg {getBgClass(
                  action.color
                )} flex items-center justify-center group-hover:scale-110 transition-transform"
              >
                <action.icon class="w-5 h-5 {getTextClass(action.color)}" />
              </div>
              <div class="flex-1">
                <p class="text-sm font-medium text-kitsuden-text {getTextHoverClass(action.color)}">
                  {action.label}
                </p>
                <p class="text-xs text-kitsuden-subtle">{action.description}</p>
              </div>
              <ArrowRight
                class="w-4 h-4 text-kitsuden-subtle opacity-0 group-hover:opacity-100 transition-all transform group-hover:translate-x-1"
              />
            </a>
          {/each}
        </div>
      </section>

      <!-- Core Grimoires -->
      <section class="card p-4">
        <h3 class="font-semibold text-kitsuden-text mb-4 flex items-center gap-2">
          <Layers class="w-4 h-4 text-kitsuden-accent" />
          {t("dashboard.coreGrimoires")}
        </h3>
        <div class="space-y-1">
          {#each coreGrimoires as grimoire}
            <a
              href={grimoire.href}
              class="group flex items-center gap-3 p-2 rounded-lg hover:bg-kitsuden-bg transition-colors"
            >
              <div
                class="w-8 h-8 rounded-lg {getBgClass(
                  grimoire.color
                )} flex items-center justify-center"
              >
                <grimoire.icon class="w-4 h-4 {getTextClass(grimoire.color)}" />
              </div>
              <div class="flex-1">
                <p
                  class="text-sm font-medium text-kitsuden-text {getTextHoverClass(grimoire.color)}"
                >
                  {grimoire.label}
                </p>
                <p class="text-xs text-kitsuden-subtle">{grimoire.description}</p>
              </div>
              <ChevronRight
                class="w-4 h-4 text-kitsuden-subtle opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </a>
          {/each}
        </div>
      </section>

      <!-- System Status -->
      <section class="card p-4">
        <h3 class="font-semibold text-kitsuden-text mb-3 flex items-center gap-2">
          <Sparkles class="w-4 h-4 text-kitsuden-accent" />
          {t("dashboard.systemStatus")}
        </h3>
        <div class="space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span class="text-kitsuden-subtle">{t("dashboard.apiStatus")}</span>
            <StatusBadge variant="active" size="sm" label={t("dashboard.online")} />
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-kitsuden-subtle">{t("dashboard.database")}</span>
            <StatusBadge variant="active" size="sm" label={t("dashboard.connected")} />
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-kitsuden-subtle">{t("dashboard.activeGrimoires")}</span>
            <span class="text-kitsuden-text font-medium">
              {#if loadingModules}
                <span class="animate-pulse">—</span>
              {:else}
                {enabledModules.length}
              {/if}
            </span>
          </div>
        </div>
      </section>

      <!-- Widget Slot: Sidebar -->
      <WidgetSlot name="dashboard:sidebar" wrapper="card" class="space-y-4" />
    </div>
  </div>

  <!-- Widget Slot: Bottom (full width) -->
  <WidgetSlot name="dashboard:bottom" wrapper="none" />
</div>

<style>
  .card {
    background-color: rgb(var(--kitsuden-card) / 1);
    border: 1px solid rgb(var(--kitsuden-border) / 1);
    border-radius: 0.75rem;
  }

  .btn-primary {
    padding: 0.5rem 0.75rem;
    background-color: rgb(var(--kitsuden-accent) / 1);
    color: black;
    border-radius: 0.5rem;
    font-weight: 500;
  }

  .btn-primary:hover {
    background-color: rgb(var(--kitsuden-accent-hover) / 1);
  }

  .hover\:border-kitsuden-accent\/30:hover {
    border-color: rgba(6, 182, 212, 0.3);
  }

  .hover\:border-green-500\/30:hover {
    border-color: rgba(34, 197, 94, 0.3);
  }

  .hover\:border-amber-500\/30:hover {
    border-color: rgba(245, 158, 11, 0.3);
  }

  .hover\:border-purple-500\/30:hover {
    border-color: rgba(168, 85, 247, 0.3);
  }

  .hover\:border-pink-500\/30:hover {
    border-color: rgba(236, 72, 153, 0.3);
  }
</style>
