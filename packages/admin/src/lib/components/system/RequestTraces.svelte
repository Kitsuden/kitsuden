<!--
  The «glass box»: each request recorded with its
  actor, kon, operation, database time and whether a write collided with the
  owner filter or with RLS. And the summary per operation.
-->
<script lang="ts">
  import {
    Button,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";

  import {
    listRequestTraces,
    requestTraceSummary,
    requestTraceTime,
    type OperationSummary,
    type RequestTrace,
  } from "$lib/services/system";

  let view = $state<"list" | "summary">("list");
  let hours = $state(24);
  let onlyBlockers = $state(false);
  let onlyErrors = $state(false);
  let actor = $state("");
  let traces = $state<RequestTrace[]>([]);
  let summary = $state<OperationSummary[]>([]);
  let turnedOnItems = $state(true);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      if (view === "list") {
        const r = await listRequestTraces({
          hours: hours,
          blocked: onlyBlockers,
          errors: onlyErrors,
          actor: actor.trim() || undefined,
        });
        turnedOnItems = r.enabled;
        traces = r.requests;
      } else {
        const r = await requestTraceSummary(hours);
        turnedOnItems = r.enabled;
        summary = r.operations;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : t("systemTraces.errorLoading");
    } finally {
      loading = false;
    }
  }

  const date = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(localeFormat());
  };
  const ms = (v: number | null) =>
    v === null || v === undefined ? "—" : `${Math.round(Number(v))} ms`;
  const reason = (m: string) =>
    m === "not_yours" ? t("systemTraces.blockedNotYours") : t("systemTraces.blockedMissing");
  const actorOf = (tr: RequestTrace) =>
    tr.actor_type === "agent"
      ? t("systemTraces.actorAgent")
      : tr.actor_type === "human"
        ? t("systemTraces.actorHuman")
        : t("systemTraces.actorAnonymous");
</script>

<div class="space-y-3" data-testid="request-traces">
  <p class="text-xs text-kitsuden-subtle">{t("systemTraces.help")}</p>

  <div class="flex flex-wrap items-center gap-2">
    <div class="flex items-center gap-1 bg-kitsuden-card p-1 rounded-lg" role="tablist">
      <button
        role="tab"
        aria-selected={view === "list"}
        class="px-3 py-1 text-xs rounded-md {view === 'list'
          ? 'bg-kitsuden-border text-kitsuden-text'
          : 'text-kitsuden-subtle'}"
        onclick={() => {
          view = "list";
          load();
        }}>{t("systemTraces.viewList")}</button
      >
      <button
        role="tab"
        aria-selected={view === "summary"}
        class="px-3 py-1 text-xs rounded-md {view === 'summary'
          ? 'bg-kitsuden-border text-kitsuden-text'
          : 'text-kitsuden-subtle'}"
        onclick={() => {
          view = "summary";
          load();
        }}>{t("systemTraces.viewSummary")}</button
      >
    </div>
    <label class="text-xs text-kitsuden-text-dim flex items-center gap-1">
      {t("systemTraces.window")}
      <select
        bind:value={hours}
        onchange={load}
        class="bg-kitsuden-card border border-kitsuden-input rounded-sm px-1 py-0.5"
      >
        <option value={1}>1 h</option>
        <option value={24}>24 h</option>
        <option value={168}>7 d</option>
      </select>
    </label>
    {#if view === "list"}
      <label class="text-xs text-kitsuden-text-dim flex items-center gap-1">
        <input
          type="checkbox"
          bind:checked={onlyBlockers}
          onchange={load}
          data-testid="only-blocked"
        />
        {t("systemTraces.onlyBlocked")}
      </label>
      <label class="text-xs text-kitsuden-text-dim flex items-center gap-1">
        <input type="checkbox" bind:checked={onlyErrors} onchange={load} />
        {t("systemTraces.onlyErrors")}
      </label>
      <input
        class="text-xs bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 w-56"
        placeholder={t("systemTraces.actorPlaceholder")}
        bind:value={actor}
        onkeydown={(e) => e.key === "Enter" && load()}
      />
    {/if}
    <div class="flex-1"></div>
    <Button variant="ghost" size="sm" onclick={load}>
      <RefreshCw size={14} class="mr-1" />{t("systemTraces.refresh")}
    </Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-kitsuden-accent"></div>
    </div>
  {:else if error}
    <div
      class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
    >
      {error}
    </div>
  {:else if !turnedOnItems}
    <p class="text-sm text-kitsuden-subtle">{t("systemTraces.disabled")}</p>
  {:else if view === "list"}
    {#if traces.length === 0}
      <p class="text-sm text-kitsuden-subtle">{t("systemTraces.empty")}</p>
    {:else}
      <div class="overflow-x-auto border border-kitsuden-border rounded-lg">
        <Table density="compact">
          <TableHeader>
            <TableRow>
              <TableHead class="text-left">{t("systemTraces.colWhen")}</TableHead>
              <TableHead class="text-left">{t("systemTraces.colRequest")}</TableHead>
              <TableHead class="text-left">{t("systemTraces.colStatus")}</TableHead>
              <TableHead class="text-left">{t("systemTraces.colActor")}</TableHead>
              <TableHead class="text-left">{t("systemTraces.colOperation")}</TableHead>
              <TableHead class="text-right">{t("systemTraces.colDuration")}</TableHead>
              <TableHead class="text-right">{t("systemTraces.colDb")}</TableHead>
              <TableHead class="text-right">{t("systemTraces.colRows")}</TableHead>
              <TableHead class="text-left">{t("systemTraces.colBlocked")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each traces as tr, i (`${tr.request_id ?? ""}-${i}`)}
              <TableRow data-testid="trace-row">
                <TableCell class="whitespace-nowrap">{date(requestTraceTime(tr))}</TableCell>
                <TableCell class="font-mono">{tr.method} {tr.route}</TableCell>
                <TableCell
                  class="px-3 py-1.5 {tr.status >= 500
                    ? 'text-kitsuden-danger'
                    : tr.status >= 400
                      ? 'text-kitsuden-amber'
                      : 'text-kitsuden-green'}">{tr.status}</TableCell
                >
                <TableCell
                  >{actorOf(tr)}<span class="block text-kitsuden-subtle font-mono"
                    >{tr.actor_id ?? ""}</span
                  ></TableCell
                >
                <TableCell>{tr.kon ?? "—"}{tr.operation ? ` · ${tr.operation}` : ""}</TableCell>
                <TableCell class="text-right">{ms(tr.duration_ms)}</TableCell>
                <TableCell class="text-right"
                  >{ms(tr.db_time_ms)}{tr.queries ? ` · ${tr.queries}q` : ""}</TableCell
                >
                <TableCell class="text-right">{tr.rows_affected ?? "—"}</TableCell>
                <TableCell>
                  {#each tr.denial_details ?? [] as b}
                    <span
                      class="inline-block mr-1 px-1.5 py-0.5 rounded-sm bg-kitsuden-amber/15 text-kitsuden-amber"
                      >{b.operation} {b.table}: {reason(b.reason)}</span
                    >
                  {/each}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  {:else if summary.length === 0}
    <p class="text-sm text-kitsuden-subtle">{t("systemTraces.empty")}</p>
  {:else}
    <div class="overflow-x-auto border border-kitsuden-border rounded-lg">
      <Table density="compact">
        <TableHeader>
          <TableRow>
            <TableHead class="text-left">{t("systemTraces.colRequest")}</TableHead>
            <TableHead class="text-left">{t("systemTraces.colOperation")}</TableHead>
            <TableHead class="text-right">{t("systemTraces.colCount")}</TableHead>
            <TableHead class="text-right">{t("systemTraces.colErrors")}</TableHead>
            <TableHead class="text-right">{t("systemTraces.colBlocked")}</TableHead>
            <TableHead class="text-right">{t("systemTraces.colP95")}</TableHead>
            <TableHead class="text-right">{t("systemTraces.colDb")}</TableHead>
            <TableHead class="text-right">{t("systemTraces.colRows")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each summary as r, i (`${r.method}-${r.route}-${i}`)}
            <TableRow>
              <TableCell class="font-mono">{r.method} {r.route}</TableCell>
              <TableCell>{r.kon ?? "—"}{r.operation ? ` · ${r.operation}` : ""}</TableCell>
              <TableCell class="text-right">{r.requests}</TableCell>
              <TableCell
                class="px-3 py-1.5 text-right {Number(r.errors) > 0
                  ? 'text-kitsuden-danger'
                  : 'text-kitsuden-subtle'}">{r.errors}</TableCell
              >
              <TableCell
                class="px-3 py-1.5 text-right {Number(r.denials) > 0
                  ? 'text-kitsuden-amber'
                  : 'text-kitsuden-subtle'}">{r.denials}</TableCell
              >
              <TableCell class="text-right">{ms(r.p95_ms)}</TableCell>
              <TableCell class="text-right">{ms(r.avg_db_ms)}</TableCell>
              <TableCell class="text-right">{r.rows}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
