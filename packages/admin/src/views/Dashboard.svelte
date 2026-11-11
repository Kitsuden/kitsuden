<!--
  Home: what needs attention and what happened, instead of shortcut lists that repeated the
  sidebar.

    KPIs            pending approvals, agent calls and failure rate (14 days), API requests (24 h)
    Agent activity  calls and failures per day; the busiest agents
    Recent changes  the approvals audit and the agents' audit log: which agent asked, which
                    person decided
    System status   API, job queue, dead jobs, kons, migrations
    Content         how much there is of each thing, linking to it

  Every block asks only for what this user may read (an editor has no agent logs, request
  traces or system status) and has its own loading, empty and error state. The mapping from
  the API's answers is in `$lib/dashboard.ts`.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { api } from "$lib/api";
  import { isAdmin, isStaff } from "$lib/auth.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import {
    activitySeries,
    activityTotals,
    busiestAgents,
    changesFeed,
    logsOf,
    requestTotals,
    systemChecks,
    timeAgo,
    type AgentLog,
    type AgentName,
    type AuditEvent,
    type CheckState,
    type OperationRow,
    type SystemCheck,
  } from "$lib/dashboard";
  import { localeFormat, t } from "$lib/i18n";
  import { approvals } from "$lib/states/approvals.svelte";
  import { moduleStore } from "$lib/states/modules.svelte";
  import {
    Badge,
    BarList,
    Button,
    ChartCard,
    DashboardGrid,
    EmptyState,
    KpiCard,
    LineChart,
    Skeleton,
    Timeline,
  } from "$lib/tallao";

  const DAYS = 14;
  const admin = $derived(isAdmin());
  const staff = $derived(isStaff());
  const locale = localeFormat();

  type Load<T> = { state: "loading" | "ready" | "error"; data: T; error?: string };
  const loading = <T,>(data: T): Load<T> => ({ state: "loading", data });

  let logs = $state<Load<AgentLog[]>>(loading([]));
  let agents = $state<AgentName[]>([]);
  let audit = $state<Load<AuditEvent[]>>(loading([]));
  let requests = $state<Load<OperationRow[]>>(loading([]));
  let tracesOn = $state(true);
  let system = $state<Load<SystemCheck[]>>(loading([]));
  let counts = $state<
    Load<Array<{ id: string; label: string; value: number | null; href?: string }>>
  >(loading([]));

  const message = (e: unknown) => (e as Error)?.message || t("home.loadFailed");

  async function loadLogs() {
    if (!admin) return;
    logs = loading(logs.data);
    try {
      const [body, list] = await Promise.all([
        api.get<unknown>("/api/admin/agents/logs?limit=500"),
        api
          .get<unknown>("/api/v1/agents")
          .then((r) => (Array.isArray(r) ? r : ((r as { data?: unknown[] })?.data ?? [])))
          .catch(() => []),
      ]);
      agents = (list as Array<{ id: string; name?: string }>).map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
      }));
      logs = { state: "ready", data: logsOf(body) };
    } catch (e) {
      logs = { state: "error", data: [], error: message(e) };
    }
  }

  async function loadAudit() {
    if (!staff) return;
    audit = loading(audit.data);
    try {
      const r = await api.get<{ events?: AuditEvent[] }>("/api/approvals/audit?limit=30");
      audit = { state: "ready", data: r.events ?? [] };
    } catch (e) {
      audit = { state: "error", data: [], error: message(e) };
    }
  }

  async function loadRequests() {
    if (!admin) return;
    requests = loading(requests.data);
    try {
      const r = await api.get<{ enabled?: boolean; operations?: OperationRow[] }>(
        "/api/admin/requests/summary?hours=24"
      );
      tracesOn = r.enabled !== false;
      requests = { state: "ready", data: r.operations ?? [] };
    } catch (e) {
      requests = { state: "error", data: [], error: message(e) };
    }
  }

  async function loadSystem() {
    system = loading(system.data);
    const API = import.meta.env.VITE_API_URL ?? "";
    const health = fetch(`${API}/api/health`)
      .then((res) => {
        void res.body?.cancel().catch(() => {});
        return res.ok;
      })
      .catch(() => false);
    // The queue and the migrations are an administrator's to read.
    const [apiOnline, queue, status] = await Promise.all([
      health,
      admin
        ? api.get<{ worker: string; dead?: unknown[] }>("/api/admin/queue").catch(() => null)
        : undefined,
      admin
        ? api
            .get<{ migrations?: { total?: number }; kons?: { total?: number; active?: number } }>(
              "/api/admin/system/status"
            )
            .catch(() => null)
        : undefined,
    ]);
    system = { state: "ready", data: systemChecks({ apiOnline, queue, status }) };
  }

  async function loadCounts() {
    counts = loading(counts.data);
    const kon = (key: string) => !admin || moduleStore.activeKon(key);
    const wanted = [
      admin && kon("kon-datasets")
        ? {
            id: "datasets",
            label: t("shell.datasets"),
            path: "/api/datasets/count",
            href: "/datasets",
          }
        : null,
      kon("kon-blog")
        ? {
            id: "posts",
            label: t("dashboard.posts"),
            path: "/api/blog/posts/count",
            href: "/g/kon-blog",
          }
        : null,
      kon("kon-media")
        ? { id: "media", label: t("shell.media"), path: "/api/media/count", href: "/g/kon-media" }
        : null,
      admin ? { id: "users", label: t("dashboard.users"), path: "/api/users/count" } : null,
    ].filter((w) => w !== null);
    const values = await Promise.all(
      wanted.map((w) =>
        api
          .get<{ count?: number }>(w.path)
          .then((r) => (typeof r.count === "number" ? r.count : null))
          .catch(() => null)
      )
    );
    counts = {
      state: "ready",
      data: wanted.map((w, i) => ({ id: w.id, label: w.label, value: values[i]!, href: w.href })),
    };
  }

  function loadAll() {
    if (staff) void approvals.refresh();
    void loadLogs();
    void loadAudit();
    void loadRequests();
    void loadSystem();
    // The content counts depend on which kons are on: wait for the module list (admin).
    void (admin ? moduleStore.whenLoaded().catch(() => {}) : Promise.resolve()).then(loadCounts);
  }
  onMount(loadAll);

  const series = $derived(activitySeries(logs.data, DAYS));
  const totals = $derived(activityTotals(series));
  const ranking = $derived(
    busiestAgents(logs.data, agents).map((row) => ({
      ...row,
      note: row.note ? t("home.failuresNote", { n: row.note }) : undefined,
    }))
  );
  const reqs = $derived(requestTotals(requests.data));
  const feed = $derived(changesFeed(audit.data, admin ? logs.data : [], agents, t));
  const feedLines = $derived(
    feed.map((item) => ({
      date: timeAgo(item.at, locale),
      title: item.title,
      description:
        item.agent && item.person
          ? t("home.byAgentAndPerson", { agent: item.agent, person: item.person })
          : item.agent
            ? t("home.byAgent", { agent: item.agent })
            : item.person
              ? t("home.byPerson", { person: item.person })
              : undefined,
      tag: item.agent ? t("record.tagAgent") : undefined,
      tone: item.tone,
      href: item.href,
    }))
  );
  const feedLoading = $derived(audit.state === "loading" || (admin && logs.state === "loading"));
  const feedError = $derived(audit.state === "error" ? audit.error : undefined);

  const dayLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`)
    );
  const chartData = $derived(series.map((d) => ({ ...d, label: dayLabel(d.day) })));

  const CHECK_LABEL: Record<SystemCheck["id"], () => string> = {
    api: () => t("home.checkApi"),
    queue: () => t("home.checkQueue"),
    deadJobs: () => t("home.checkDeadJobs"),
    kons: () => t("home.checkKons"),
    migrations: () => t("home.checkMigrations"),
  };
  const STATE_LABEL: Record<CheckState, () => string> = {
    ok: () => t("home.stateOk"),
    warn: () => t("home.stateWarn"),
    down: () => t("home.stateDown"),
    unknown: () => t("home.stateUnknown"),
  };
  const STATE_VARIANT = {
    ok: "success",
    warn: "warning",
    down: "error",
    unknown: "default",
  } as const;
  const CHECK_HREF: Partial<Record<SystemCheck["id"], string>> = {
    queue: "/activity?tab=queue",
    deadJobs: "/activity?tab=queue",
    kons: "/kons",
  };
  const number = (n: number) => n.toLocaleString(locale);
</script>

<Page title={t("shell.home")} description={t("dashboard.overviewOfYourKitsudenCms")}>
  {#snippet actions()}
    <Button variant="secondary" onclick={loadAll}>{t("dashboard.refresh")}</Button>
    {#if staff && approvals.pendingItems > 0}
      <Button href="/approvals" data-testid="review-approvals">
        {t("home.reviewApprovals", { n: approvals.pendingItems })}
      </Button>
    {/if}
  {/snippet}

  <DashboardGrid columns={4}>
    {#if staff}
      <KpiCard
        label={t("home.pendingApprovals")}
        value={approvals.pendingItems}
        {locale}
        goodWhen="none"
      />
    {/if}
    {#if admin}
      {#if logs.state === "loading"}
        <div class="kitsuden-home-kpi"><Skeleton height="6.5rem" /></div>
        <div class="kitsuden-home-kpi"><Skeleton height="6.5rem" /></div>
      {:else}
        <KpiCard
          label={t("home.agentCalls", { days: DAYS })}
          value={logs.state === "error" ? "—" : totals.calls}
          delta={logs.state === "error" ? null : totals.delta}
          deltaLabel={t("home.vsEarlierHalf")}
          goodWhen="none"
          trend={series.map((d) => d.calls)}
          {locale}
        />
        <KpiCard
          label={t("home.failureRate")}
          value={logs.state === "error" ? "—" : totals.failureRate}
          unit="%"
          trend={series.map((d) => d.failures)}
          {locale}
        />
      {/if}
      {#if requests.state === "loading"}
        <div class="kitsuden-home-kpi"><Skeleton height="6.5rem" /></div>
      {:else}
        <KpiCard
          label={t("home.requests24h")}
          value={requests.state === "error" || !tracesOn ? "—" : reqs.requests}
          unit={requests.state === "ready" && tracesOn
            ? t("home.errorsUnit", { n: number(reqs.errors) })
            : undefined}
          {locale}
        />
      {/if}
    {/if}

    {#if admin}
      <ChartCard
        title={t("home.agentActivity")}
        description={t("home.agentActivityHint", { days: DAYS })}
        span={3}
        level={2}
      >
        {#snippet toolbar()}
          <Button variant="ghost" size="sm" href="/activity?tab=agents"
            >{t("dashboard.viewAll")}</Button
          >
        {/snippet}
        {#if logs.state === "loading"}
          <Skeleton height="14rem" />
        {:else if logs.state === "error"}
          <EmptyState
            variant="error"
            size="sm"
            level={null}
            description={logs.error}
            onRetry={loadLogs}
          />
        {:else if totals.calls === 0}
          <EmptyState
            size="sm"
            level={null}
            title={t("home.noAgentActivity")}
            description={t("home.noAgentActivityHint")}
            actionLabel={t("shell.agents")}
            actionHref="/agents"
          />
        {:else}
          <LineChart
            data={chartData}
            x="label"
            series={[
              { key: "calls", label: t("home.seriesCalls") },
              { key: "failures", label: t("home.seriesFailures") },
            ]}
            title={t("home.agentActivity")}
            hideTitle
            area
            height={240}
            {locale}
          />
        {/if}
      </ChartCard>

      <ChartCard
        title={t("home.busiestAgents")}
        description={t("home.busiestAgentsHint")}
        level={2}
      >
        {#if logs.state === "loading"}
          <Skeleton lines={5} />
        {:else if logs.state === "error"}
          <EmptyState
            variant="error"
            size="sm"
            level={null}
            description={logs.error}
            onRetry={loadLogs}
          />
        {:else}
          <BarList
            data={ranking}
            ariaLabel={t("home.busiestAgents")}
            {locale}
            emptyText={t("home.noAgentActivity")}
          />
        {/if}
      </ChartCard>
    {/if}

    {#if staff}
      <ChartCard
        title={t("home.recentChanges")}
        description={t("home.recentChangesHint")}
        span={admin ? 2 : 3}
        level={2}
      >
        {#snippet toolbar()}
          {#if admin}
            <Button variant="ghost" size="sm" href="/activity?tab=audit"
              >{t("dashboard.viewAll")}</Button
            >
          {/if}
        {/snippet}
        {#if feedLoading}
          <Skeleton lines={6} />
        {:else if feedError}
          <EmptyState
            variant="error"
            size="sm"
            level={null}
            description={feedError}
            onRetry={loadAudit}
          />
        {:else if feedLines.length === 0}
          <EmptyState
            size="sm"
            level={null}
            title={t("dashboard.noRecentActivity")}
            description={t("home.noChangesHint")}
          />
        {:else}
          <div data-testid="changes-feed">
            <Timeline items={feedLines} ariaLabel={t("home.recentChanges")} {locale} />
          </div>
        {/if}
      </ChartCard>
    {/if}

    <ChartCard title={t("dashboard.systemStatus")} span={admin ? 2 : 1} level={2}>
      {#if system.state === "loading"}
        <Skeleton lines={4} />
      {:else}
        <ul class="kitsuden-home-checks" data-testid="system-status">
          {#each system.data as check (check.id)}
            <li>
              {#if CHECK_HREF[check.id]}
                <a href={CHECK_HREF[check.id]}>{CHECK_LABEL[check.id]()}</a>
              {:else}
                <span>{CHECK_LABEL[check.id]()}</span>
              {/if}
              <span class="kitsuden-home-check-value">
                {#if check.value && check.id !== "queue"}<span>{check.value}</span>{/if}
                <Badge variant={STATE_VARIANT[check.state]} size="sm" dot>
                  {STATE_LABEL[check.state]()}
                </Badge>
              </span>
            </li>
          {/each}
        </ul>
        {#if admin && requests.state === "ready" && tracesOn && reqs.slowest}
          <p class="kitsuden-home-note">
            {t("home.slowest", {
              route: `${reqs.slowest.method} ${reqs.slowest.route}`,
              ms: number(Math.round(Number(reqs.slowest.p95_ms))),
            })}
            · {t("home.denials", { n: number(reqs.denials) })}
          </p>
        {/if}
      {/if}
    </ChartCard>

    {#if counts.state === "loading"}
      {#each Array(admin ? 4 : 2) as _}
        <div class="kitsuden-home-kpi"><Skeleton height="5.5rem" /></div>
      {/each}
    {:else}
      {#each counts.data as item (item.id)}
        <svelte:element
          this={item.href ? "a" : "div"}
          class="kitsuden-home-count"
          href={item.href}
          data-testid="count-{item.id}"
        >
          <KpiCard label={item.label} value={item.value ?? "—"} {locale} />
        </svelte:element>
      {/each}
    {/if}
  </DashboardGrid>
</Page>

<style>
  .kitsuden-home-kpi {
    min-width: 0;
  }
  .kitsuden-home-count {
    display: block;
    min-width: 0;
    color: inherit;
    text-decoration: none;
    border-radius: var(--ta-radius-lg);
  }
  .kitsuden-home-count:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }
  .kitsuden-home-count[href]:hover :global(.ta-kpi) {
    border-color: rgb(var(--ta-accent) / 0.5);
  }
  .kitsuden-home-checks {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .kitsuden-home-checks li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    font-size: 0.875rem;
    border-bottom: 1px solid rgb(var(--ta-border) / 0.6);
  }
  .kitsuden-home-checks li:last-child {
    border-bottom: none;
  }
  .kitsuden-home-checks a {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: rgb(var(--ta-text-dim) / 0.5);
    text-underline-offset: 3px;
  }
  .kitsuden-home-check-value {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: rgb(var(--ta-text-dim));
  }
  .kitsuden-home-note {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    overflow-wrap: anywhere;
  }
</style>
