<script lang="ts">
  import {
    Alert,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CodeBlock,
    DescriptionList,
    Dialog,
    EmptyState,
    Select,
    Spinner,
    Stat,
    Switch,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { t, localeFormat } from "$lib/i18n";
  /**
   * Run Inspector — execution observability
   *
   * The data was already captured in `action_executions` (status, payload, logs,
   * duration, memory) but could only be queried per action. This view is
   * the global feed: "what is happening in my backend right now".
   *
   * It consumes /api/runs (admin-only). Auto-refreshes every 5s while
   * enabled, and the detail is loaded on demand so as not to fetch the logs of everything.
   */
  import { onDestroy } from "svelte";

  const API = import.meta.env.VITE_API_URL ?? "";

  interface Run {
    id: string;
    actionId: string;
    actionName: string | null;
    actionType: string | null;
    status: string;
    triggerType: string | null;
    triggerEvent: string | null;
    durationMs: number | null;
    memoryUsedBytes: number | null;
    errorMessage: string | null;
    startedAt: string | null;
    createdAt: string;
  }

  interface Stats {
    total: number;
    byStatus: Record<string, number>;
    successRate: number;
    duration: { avgMs: number; p50: number; p95: number; maxMs: number };
    topFailing: { actionId: string; actionName: string | null; failures: number }[];
  }

  let runs = $state<Run[]>([]);
  let stats = $state<Stats | null>(null);
  let selected = $state<any | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let statusFilter = $state("");
  let windowFilter = $state("24h");
  let autoRefresh = $state(true);

  const STATUS_VARIANT: Record<string, "success" | "error" | "accent" | "default"> = {
    success: "success",
    failed: "error",
    running: "accent",
    pending: "default",
  };

  async function load() {
    error = null;
    try {
      const qs = new URLSearchParams({ window: windowFilter, limit: "50" });
      if (statusFilter) qs.set("status", statusFilter);

      const [runsRes, statsRes] = await Promise.all([
        fetch(`${API}/api/runs?${qs}`, { credentials: "include" }),
        fetch(`${API}/api/runs/stats?window=${windowFilter}`, { credentials: "include" }),
      ]);

      if (!runsRes.ok) throw new Error(t("runsView.runs", { status: runsRes.status }));
      runs = (await runsRes.json()).docs ?? [];
      if (statsRes.ok) stats = await statsRes.json();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function openDetail(id: string) {
    selected = null;
    const res = await fetch(`${API}/api/runs/${id}`, { credentials: "include" });
    if (res.ok) selected = await res.json();
  }

  // Auto-refresh: restarts when the filters or the toggle change.
  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    void statusFilter;
    void windowFilter;
    load();

    if (timer) clearInterval(timer);
    if (autoRefresh) timer = setInterval(load, 5000);
    return () => {
      if (timer) clearInterval(timer);
    };
  });
  onDestroy(() => timer && clearInterval(timer));

  const ms = (v: number | null) =>
    v === null ? "—" : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(2)} s`;
  const mb = (v: number | null) => (v === null ? "—" : `${(v / 1048576).toFixed(1)} MB`);
  const ago = (iso: string) => {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString(localeFormat());
  };
</script>

<ViewPage title={t("runsView.runInspector")} description={t("runsView.actionExecutionsWorkersAnd")}>
  {#snippet actions()}
    <Switch bind:checked={autoRefresh} label={t("runsView.auto5s")} size="sm" />
    <Select
      bind:value={windowFilter}
      width="auto"
      aria-label={t("runsView.timeWindow")}
      options={[
        { value: "1h", label: t("runsView.lastHour") },
        { value: "24h", label: t("runsView.n24Hours") },
        { value: "7d", label: t("runsView.n7Days") },
        { value: "30d", label: t("runsView.n30Days") },
      ]}
    />
    <Select
      bind:value={statusFilter}
      width="auto"
      aria-label={t("runsView.filterByStatus")}
      options={[
        { value: "", label: t("runsView.all") },
        { value: "success", label: t("runsView.success") },
        { value: "failed", label: t("runsView.failedItems") },
        { value: "running", label: t("runsView.inProgress") },
        { value: "pending", label: t("runsView.pendingItems") },
      ]}
    />
  {/snippet}

  <div class="space-y-6 min-w-0">
    {#if error}
      <Alert variant="error">{error}</Alert>
    {/if}

    {#if stats}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t("runsView.executions")} value={stats.total} />
        <Stat
          label={t("runsView.successRate")}
          value={`${stats.successRate}%`}
          variant={stats.successRate >= 99
            ? "success"
            : stats.successRate < 95
              ? "error"
              : "default"}
        />
        <Stat
          label={t("runsView.latencyP95")}
          value={`${ms(stats.duration.p95)} · p50 ${ms(stats.duration.p50)}`}
        />
        <Stat
          label={t("runsView.failedItems")}
          value={stats.byStatus.failed ?? 0}
          variant={(stats.byStatus.failed ?? 0) > 0 ? "error" : "default"}
        />
      </div>

      {#if stats.topFailing.length > 0}
        <Card>
          <CardHeader>
            <CardTitle level={2}>{t("runsView.actionsWithMostFailures")}</CardTitle>
          </CardHeader>
          <CardContent class="space-y-1">
            {#each stats.topFailing as f (f.actionId)}
              <div class="flex justify-between gap-3 text-sm">
                <span class="min-w-0 truncate">{f.actionName ?? f.actionId}</span>
                <span class="text-kitsuden-danger font-medium">{f.failures}</span>
              </div>
            {/each}
          </CardContent>
        </Card>
      {/if}
    {/if}

    {#if loading}
      <div class="flex justify-center p-8"><Spinner /></div>
    {:else if runs.length === 0}
      <EmptyState title={t("runsView.withoutRunsInThisWindow")} />
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("common.status")}</TableHead>
            <TableHead>{t("runsView.action")}</TableHead>
            <TableHead>{t("runsView.trigger")}</TableHead>
            <TableHead class="text-right">{t("runsView.duration")}</TableHead>
            <TableHead class="text-right">{t("runsView.memory")}</TableHead>
            <TableHead class="text-right">{t("runsView.when")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each runs as run (run.id)}
            <TableRow class="cursor-pointer" onclick={() => openDetail(run.id)}>
              <TableCell>
                <Badge variant={STATUS_VARIANT[run.status] ?? "default"}>{run.status}</Badge>
              </TableCell>
              <TableCell class="font-medium">{run.actionName ?? "—"}</TableCell>
              <TableCell class="text-kitsuden-text-dim">
                {run.triggerEvent ?? run.triggerType ?? "—"}
              </TableCell>
              <TableCell class="text-right tabular-nums">{ms(run.durationMs)}</TableCell>
              <TableCell class="text-right tabular-nums text-kitsuden-text-dim">
                {mb(run.memoryUsedBytes)}
              </TableCell>
              <TableCell class="text-right text-kitsuden-text-dim">{ago(run.createdAt)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </div>

  <Dialog
    open={!!selected}
    size="2xl"
    title={selected?.action?.name ?? t("runsView.execution")}
    description={selected?.id}
    closeLabel={t("runsView.close")}
    onClose={() => (selected = null)}
  >
    {#if selected}
      <div class="space-y-4 min-w-0">
        <DescriptionList
          ariaLabel={t("runsView.executionDetail")}
          layout="stacked"
          columns={2}
          items={[
            { label: t("common.status"), value: selected.status },
            { label: t("runsView.duration"), value: ms(selected.durationMs) },
            { label: t("runsView.memory"), value: mb(selected.memoryUsedBytes) },
            {
              label: t("runsView.trigger"),
              value: selected.triggerEvent ?? selected.triggerType ?? "—",
            },
          ]}
        />

        {#if selected.errorMessage}
          <Alert variant="error" title={t("common.error")}>
            <span class="whitespace-pre-wrap break-words">{selected.errorMessage}</span>
          </Alert>
        {/if}

        {#if selected.triggerPayload}
          <section>
            <h3 class="text-xs uppercase tracking-wide text-kitsuden-text-dim mb-1">
              {t("runsView.payload")}
            </h3>
            <CodeBlock code={JSON.stringify(selected.triggerPayload, null, 2)} language="json" />
          </section>
        {/if}

        {#if selected.result}
          <section>
            <h3 class="text-xs uppercase tracking-wide text-kitsuden-text-dim mb-1">
              {t("runsView.result")}
            </h3>
            <CodeBlock code={JSON.stringify(selected.result, null, 2)} language="json" />
          </section>
        {/if}

        {#if selected.logLines?.length}
          <section>
            <h3 class="text-xs uppercase tracking-wide text-kitsuden-text-dim mb-1">
              {t("runsView.logs", { logLinesCount: selected.logLines.length })}
            </h3>
            <CodeBlock code={selected.logLines.join("\n")} maxHeight="16rem" />
          </section>
        {/if}
      </div>
    {/if}
  </Dialog>
</ViewPage>
