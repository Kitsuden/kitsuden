<!--
  The «glass box»: each request recorded with its
  actor, kon, operation, database time and whether a write collided with the
  owner filter or with RLS. And the summary per operation.
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";

  import Button from "$lib/components/ui/Button.svelte";
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
  <p class="text-xs text-zinc-500">{t("systemTraces.help")}</p>

  <div class="flex flex-wrap items-center gap-2">
    <div class="flex items-center gap-1 bg-zinc-900 p-1 rounded-lg" role="tablist">
      <button
        role="tab"
        aria-selected={view === "list"}
        class="px-3 py-1 text-xs rounded-md {view === 'list'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500'}"
        onclick={() => {
          view = "list";
          load();
        }}>{t("systemTraces.viewList")}</button
      >
      <button
        role="tab"
        aria-selected={view === "summary"}
        class="px-3 py-1 text-xs rounded-md {view === 'summary'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500'}"
        onclick={() => {
          view = "summary";
          load();
        }}>{t("systemTraces.viewSummary")}</button
      >
    </div>
    <label class="text-xs text-zinc-400 flex items-center gap-1">
      {t("systemTraces.window")}
      <select
        bind:value={hours}
        onchange={load}
        class="bg-zinc-900 border border-zinc-800 rounded-sm px-1 py-0.5"
      >
        <option value={1}>1 h</option>
        <option value={24}>24 h</option>
        <option value={168}>7 d</option>
      </select>
    </label>
    {#if view === "list"}
      <label class="text-xs text-zinc-400 flex items-center gap-1">
        <input
          type="checkbox"
          bind:checked={onlyBlockers}
          onchange={load}
          data-testid="only-blocked"
        />
        {t("systemTraces.onlyBlocked")}
      </label>
      <label class="text-xs text-zinc-400 flex items-center gap-1">
        <input type="checkbox" bind:checked={onlyErrors} onchange={load} />
        {t("systemTraces.onlyErrors")}
      </label>
      <input
        class="text-xs bg-zinc-900 border border-zinc-800 rounded-sm px-2 py-1 w-56"
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
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if !turnedOnItems}
    <p class="text-sm text-zinc-500">{t("systemTraces.disabled")}</p>
  {:else if view === "list"}
    {#if traces.length === 0}
      <p class="text-sm text-zinc-500">{t("systemTraces.empty")}</p>
    {:else}
      <div class="overflow-x-auto border border-zinc-800 rounded-lg">
        <table class="w-full text-xs">
          <thead class="text-zinc-500">
            <tr>
              <th class="text-left px-3 py-2">{t("systemTraces.colWhen")}</th>
              <th class="text-left px-3 py-2">{t("systemTraces.colRequest")}</th>
              <th class="text-left px-3 py-2">{t("systemTraces.colStatus")}</th>
              <th class="text-left px-3 py-2">{t("systemTraces.colActor")}</th>
              <th class="text-left px-3 py-2">{t("systemTraces.colOperation")}</th>
              <th class="text-right px-3 py-2">{t("systemTraces.colDuration")}</th>
              <th class="text-right px-3 py-2">{t("systemTraces.colDb")}</th>
              <th class="text-right px-3 py-2">{t("systemTraces.colRows")}</th>
              <th class="text-left px-3 py-2">{t("systemTraces.colBlocked")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800/70">
            {#each traces as tr, i (`${tr.request_id ?? ""}-${i}`)}
              <tr data-testid="trace-row">
                <td class="px-3 py-1.5 whitespace-nowrap text-zinc-400"
                  >{date(requestTraceTime(tr))}</td
                >
                <td class="px-3 py-1.5 font-mono text-zinc-200">{tr.method} {tr.route}</td>
                <td
                  class="px-3 py-1.5 {tr.status >= 500
                    ? 'text-red-300'
                    : tr.status >= 400
                      ? 'text-amber-300'
                      : 'text-emerald-300'}">{tr.status}</td
                >
                <td class="px-3 py-1.5 text-zinc-300"
                  >{actorOf(tr)}<span class="block text-zinc-500 font-mono"
                    >{tr.actor_id ?? ""}</span
                  ></td
                >
                <td class="px-3 py-1.5 text-zinc-400"
                  >{tr.kon ?? "—"}{tr.operation ? ` · ${tr.operation}` : ""}</td
                >
                <td class="px-3 py-1.5 text-right text-zinc-300">{ms(tr.duration_ms)}</td>
                <td class="px-3 py-1.5 text-right text-zinc-400"
                  >{ms(tr.db_time_ms)}{tr.queries ? ` · ${tr.queries}q` : ""}</td
                >
                <td class="px-3 py-1.5 text-right text-zinc-400">{tr.rows_affected ?? "—"}</td>
                <td class="px-3 py-1.5">
                  {#each tr.denial_details ?? [] as b}
                    <span
                      class="inline-block mr-1 px-1.5 py-0.5 rounded-sm bg-amber-500/15 text-amber-300"
                      >{b.operation} {b.table}: {reason(b.reason)}</span
                    >
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else if summary.length === 0}
    <p class="text-sm text-zinc-500">{t("systemTraces.empty")}</p>
  {:else}
    <div class="overflow-x-auto border border-zinc-800 rounded-lg">
      <table class="w-full text-xs">
        <thead class="text-zinc-500">
          <tr>
            <th class="text-left px-3 py-2">{t("systemTraces.colRequest")}</th>
            <th class="text-left px-3 py-2">{t("systemTraces.colOperation")}</th>
            <th class="text-right px-3 py-2">{t("systemTraces.colCount")}</th>
            <th class="text-right px-3 py-2">{t("systemTraces.colErrors")}</th>
            <th class="text-right px-3 py-2">{t("systemTraces.colBlocked")}</th>
            <th class="text-right px-3 py-2">{t("systemTraces.colP95")}</th>
            <th class="text-right px-3 py-2">{t("systemTraces.colDb")}</th>
            <th class="text-right px-3 py-2">{t("systemTraces.colRows")}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-800/70">
          {#each summary as r, i (`${r.method}-${r.route}-${i}`)}
            <tr>
              <td class="px-3 py-1.5 font-mono text-zinc-200">{r.method} {r.route}</td>
              <td class="px-3 py-1.5 text-zinc-400"
                >{r.kon ?? "—"}{r.operation ? ` · ${r.operation}` : ""}</td
              >
              <td class="px-3 py-1.5 text-right text-zinc-300">{r.requests}</td>
              <td
                class="px-3 py-1.5 text-right {Number(r.errors) > 0
                  ? 'text-red-300'
                  : 'text-zinc-500'}">{r.errors}</td
              >
              <td
                class="px-3 py-1.5 text-right {Number(r.denials) > 0
                  ? 'text-amber-300'
                  : 'text-zinc-500'}">{r.denials}</td
              >
              <td class="px-3 py-1.5 text-right text-zinc-300">{ms(r.p95_ms)}</td>
              <td class="px-3 py-1.5 text-right text-zinc-400">{ms(r.avg_db_ms)}</td>
              <td class="px-3 py-1.5 text-right text-zinc-400">{r.rows}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
