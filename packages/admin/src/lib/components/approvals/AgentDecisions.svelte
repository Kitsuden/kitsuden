<!--
  What agents chose NOT to do, and why: recorded by the agents themselves
  (MCP kitsuden_record_decision, POST /api/agent/decisions). Read-only, admins
  only (GET /api/v1/agent-decisions). Shown next to the inbox, where the
  rejected proposals are.
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";

  import Button from "$lib/components/ui/Button.svelte";
  import { listAgentDecisions, type AgentDecision } from "$lib/services/agents";

  interface Props {
    /** Only this agent's decisions (the agent page). */
    agentId?: string;
  }
  const { agentId }: Props = $props();

  const PERIODS = [7, 30, 90, 365];
  let days = $state(30);
  let decisions = $state<AgentDecision[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      const r = await listAgentDecisions({ agentId, days, limit: 200 });
      decisions = r.decisions;
      total = r.total;
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentDecisions.errorLoading");
    } finally {
      loading = false;
    }
  }

  const date = (v: string) => new Date(v).toLocaleString(localeFormat());
</script>

<div class="space-y-4" data-testid="agent-decisions">
  <div class="flex flex-wrap items-start gap-3">
    <div class="min-w-0 flex-1">
      <h3 class="text-sm font-semibold text-zinc-300">{t("agentDecisions.title")}</h3>
      <p class="text-xs text-zinc-500">{t("agentDecisions.help")}</p>
    </div>
    <select
      bind:value={days}
      onchange={load}
      aria-label={t("agentDecisions.days", { n: days })}
      class="px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-xs text-zinc-200"
    >
      {#each PERIODS as p}
        <option value={p}>{t("agentDecisions.days", { n: p })}</option>
      {/each}
    </select>
    <Button variant="ghost" size="sm" onclick={load}><RefreshCw size={14} /></Button>
    <a href="/approvals?tab=inbox" class="text-xs text-indigo-300 hover:underline self-center"
      >{t("agentDecisions.inboxLink")}</a
    >
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if decisions.length === 0}
    <p class="text-sm text-zinc-500 py-6 text-center">{t("agentDecisions.empty")}</p>
  {:else}
    <p class="text-xs text-zinc-500">{t("agentDecisions.total", { n: total })}</p>
    <div class="overflow-x-auto border border-zinc-800 rounded-lg">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900 text-xs text-zinc-500 text-left">
          <tr>
            <th class="px-3 py-2 font-medium">{t("agentDecisions.colWhen")}</th>
            {#if !agentId}<th class="px-3 py-2 font-medium">{t("agentDecisions.colAgent")}</th>{/if}
            <th class="px-3 py-2 font-medium">{t("agentDecisions.colAction")}</th>
            <th class="px-3 py-2 font-medium">{t("agentDecisions.colReason")}</th>
            <th class="px-3 py-2 font-medium">{t("agentDecisions.colAlternatives")}</th>
            <th class="px-3 py-2 font-medium">{t("agentDecisions.colVersion")}</th>
          </tr>
        </thead>
        <tbody>
          {#each decisions as d (d.id)}
            <tr class="border-t border-zinc-800 align-top" data-testid="decision-row">
              <td class="px-3 py-2 whitespace-nowrap text-xs text-zinc-500">{date(d.createdAt)}</td>
              {#if !agentId}
                <td class="px-3 py-2 whitespace-nowrap">
                  <a href="/agents/{d.agentId}" class="text-indigo-300 hover:underline"
                    >{d.agentName ?? d.agentId}</a
                  >
                </td>
              {/if}
              <td class="px-3 py-2 text-zinc-200">{d.action}</td>
              <td class="px-3 py-2 text-zinc-400">{d.reason}</td>
              <td class="px-3 py-2 text-zinc-400">
                {#each d.alternatives as a}<div>{a}</div>{/each}
              </td>
              <td class="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">
                {d.version != null ? t("agentVersions.version", { n: d.version }) : ""}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
