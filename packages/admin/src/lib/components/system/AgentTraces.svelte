<script lang="ts">
  import { Alert, Button, Card, EmptyState, SearchInput, Spinner } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import { Activity, Bot, Clock, Coins } from "lucide-svelte";
  import { onMount } from "svelte";

  import Timeline from "$lib/components/agents/Timeline.svelte";
  import { listTracesPage, getTrace } from "$lib/services/agents";
  import type { AgentTrace, AgentTraceStep } from "$lib/types/agents";

  let traces: AgentTrace[] = $state([]);
  let selectedTrace: (AgentTrace & { steps: AgentTraceStep[] }) | null = $state(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let total = $state(0);
  let offset = $state(0);
  const limit = 20;

  onMount(async () => {
    await loadTraces();
  });

  async function loadTraces() {
    try {
      loading = true;
      error = null;
      // `total` is the API's count, not this page's length: with `traces.length` the
      // condition for "Load more" (`traces.length < total`) could never be true. And a
      // further page is ADDED to the list; it used to replace it.
      const page = await listTracesPage({ limit, offset });
      traces = offset === 0 ? page.traces : [...traces, ...page.traces];
      total = Math.max(page.total, traces.length);
    } catch (e) {
      error = e instanceof Error ? e.message : t("tracesPage.errorLoadingTraces");
    } finally {
      loading = false;
    }
  }

  async function selectTrace(trace: AgentTrace) {
    try {
      selectedTrace = await getTrace(trace.id);
    } catch (e) {
      error = e instanceof Error ? e.message : t("tracesPage.errorLoadingTrace");
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function formatDate(date: string): string {
    return new Date(date).toLocaleString(localeFormat(), {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getStatusIcon(status: string) {
    switch (status) {
      case "success":
        return "✓";
      case "error":
        return "✗";
      case "running":
        return "⟳";
      default:
        return "○";
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case "success":
        return "text-kitsuden-green";
      case "error":
        return "text-kitsuden-danger";
      case "running":
        return "text-kitsuden-amber";
      default:
        return "text-kitsuden-subtle";
    }
  }
</script>

<div class="flex flex-col md:flex-row h-full min-w-0">
  <!-- Sidebar - Trace List -->
  <div
    class="w-full md:w-96 md:shrink-0 border-b md:border-b-0 md:border-r border-kitsuden-border flex flex-col min-w-0"
  >
    <p class="px-4 py-3 border-b border-kitsuden-border text-xs text-kitsuden-subtle">
      {total}
      {t("tracesPage.registeredTraces")}
    </p>

    <!-- Filters -->
    <div class="p-3 border-b border-kitsuden-border">
      <SearchInput
        size="sm"
        placeholder={t("tracesPage.searchTraces")}
        ariaLabel={t("tracesPage.searchTraces")}
      />
    </div>

    <!-- Trace List -->
    <div class="flex-1 overflow-y-auto">
      {#if loading}
        <div class="flex items-center justify-center h-32">
          <Spinner />
        </div>
      {:else if error}
        <div class="m-4"><Alert variant="error">{error}</Alert></div>
      {:else if traces.length === 0}
        <EmptyState size="sm" title={t("tracesPage.noTraces")} />
      {:else}
        <div class="divide-y divide-kitsuden-border/50">
          {#each traces as trace}
            <button
              type="button"
              class="w-full p-3 text-left hover:bg-kitsuden-border/30 transition-colors {selectedTrace?.id ===
              trace.id
                ? 'bg-kitsuden-border/50'
                : ''}"
              onclick={() => selectTrace(trace)}
            >
              <div class="flex items-start justify-between gap-2 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                  <span class={getStatusColor(trace.status)}>{getStatusIcon(trace.status)}</span>
                  <span class="text-sm font-medium text-kitsuden-text truncate max-w-[140px]"
                    >{trace.sessionId || t("tracesPage.withoutSession")}</span
                  >
                </div>
                <span class="text-xs text-kitsuden-subtle">{formatDate(trace.createdAt)}</span>
              </div>

              <div class="flex flex-wrap items-center gap-3 mt-2 text-xs text-kitsuden-subtle">
                <span class="flex items-center gap-1">
                  <Bot size={12} />
                  {trace.agentName || t("tracesPage.agent")}
                </span>
                <span class="flex items-center gap-1">
                  <Clock size={12} />
                  {formatDuration(trace.totalDurationMs)}
                </span>
                <span class="flex items-center gap-1">
                  <Coins size={12} />
                  {trace.totalTokens.toLocaleString(localeFormat())}
                </span>
              </div>
            </button>
          {/each}
        </div>

        {#if traces.length < total}
          <div class="p-4 text-center">
            <Button
              variant="ghost"
              size="sm"
              onclick={() => {
                offset += limit;
                loadTraces();
              }}
            >
              {t("tracesPage.loadMore")}
            </Button>
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Main Content - Trace Detail -->
  <div class="flex-1 overflow-y-auto min-w-0">
    {#if selectedTrace}
      <div class="p-4 md:p-6 space-y-6">
        <!-- Header -->
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="{getStatusColor(selectedTrace.status)} text-lg"
                >{getStatusIcon(selectedTrace.status)}</span
              >
              <h2 class="text-xl font-semibold text-kitsuden-text">
                {t("tracesPage.trace", { v: selectedTrace.id.slice(-8) })}
              </h2>
            </div>
            <p class="text-sm text-kitsuden-subtle mt-1">
              {new Date(selectedTrace.createdAt).toLocaleString(localeFormat())}
            </p>
          </div>

          <div class="flex items-center gap-4 text-sm">
            <div class="text-center">
              <p class="text-2xl font-semibold text-kitsuden-text">
                {formatDuration(selectedTrace.totalDurationMs)}
              </p>
              <p class="text-xs text-kitsuden-subtle">{t("tracesPage.duration")}</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-semibold text-kitsuden-text">
                {selectedTrace.totalTokens.toLocaleString(localeFormat())}
              </p>
              <p class="text-xs text-kitsuden-subtle">{t("tracesPage.tokens")}</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-semibold text-kitsuden-text">
                {selectedTrace.steps?.length || 0}
              </p>
              <p class="text-xs text-kitsuden-subtle">{t("tracesPage.steps")}</p>
            </div>
          </div>
        </div>

        <!-- Timeline -->
        {#if selectedTrace.steps?.length > 0}
          <Card class="p-4 md:p-6">
            <h3 class="text-sm font-medium text-kitsuden-text-dim mb-4">
              {t("tracesPage.execution")}
            </h3>
            <Timeline steps={selectedTrace.steps} />
          </Card>
        {:else}
          <EmptyState title={t("tracesPage.noStepsRecordedFor")} />
        {/if}
      </div>
    {:else}
      <div class="flex items-center justify-center h-full p-6 text-kitsuden-subtle">
        <div class="text-center">
          <Activity size={48} class="mx-auto mb-4 opacity-50" aria-hidden="true" />
          <p>{t("tracesPage.selectATraceToView")}</p>
        </div>
      </div>
    {/if}
  </div>
</div>
