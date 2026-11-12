<!--
  What agents chose NOT to do, and why: recorded by the agents themselves
  (MCP kitsuden_record_decision, POST /api/agent/decisions). Read-only, admins
  only (GET /api/v1/agent-decisions). Shown next to the inbox, where the
  rejected proposals are.
-->
<script lang="ts">
  import {
    Alert,
    Button,
    EmptyState,
    Select,
    Skeleton,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { formatDateTime } from "$lib/utils";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";
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

  // The panel's one way of writing a moment (see $lib/utils).
  const date = formatDateTime;
</script>

<div class="space-y-4" data-testid="agent-decisions">
  <div class="flex flex-wrap items-start gap-3">
    <div class="min-w-0 flex-1">
      <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentDecisions.title")}</h3>
      <p class="text-xs text-kitsuden-subtle">{t("agentDecisions.help")}</p>
    </div>
    <Select
      size="sm"
      width="auto"
      value={String(days)}
      onchange={(e: Event) => {
        days = Number((e.currentTarget as HTMLSelectElement).value);
        void load();
      }}
      aria-label={t("agentDecisions.days", { n: days })}
      options={PERIODS.map((p) => ({
        value: String(p),
        label: t("agentDecisions.days", { n: p }),
      }))}
    />
    <Button variant="ghost" size="icon" ariaLabel={t("approvals.refresh")} onclick={load}
      ><RefreshCw size={14} aria-hidden="true" /></Button
    >
    <a href="/approvals?tab=inbox" class="text-xs text-kitsuden-accent hover:underline self-center"
      >{t("agentDecisions.inboxLink")}</a
    >
  </div>

  {#if loading}
    <Skeleton lines={3} />
  {:else if error}
    <Alert variant="error">{error}</Alert>
  {:else if decisions.length === 0}
    <EmptyState size="sm" title={t("agentDecisions.empty")} />
  {:else}
    <p class="text-xs text-kitsuden-subtle">{t("agentDecisions.total", { n: total })}</p>
    <div class="min-w-0">
      <Table class="w-full text-sm">
        <TableHeader class="text-xs text-kitsuden-subtle text-left">
          <TableRow>
            <TableHead class="px-3 py-2 font-medium">{t("agentDecisions.colWhen")}</TableHead>
            {#if !agentId}<TableHead class="px-3 py-2 font-medium"
                >{t("agentDecisions.colAgent")}</TableHead
              >{/if}
            <TableHead class="px-3 py-2 font-medium">{t("agentDecisions.colAction")}</TableHead>
            <TableHead class="px-3 py-2 font-medium">{t("agentDecisions.colReason")}</TableHead>
            <TableHead class="px-3 py-2 font-medium"
              >{t("agentDecisions.colAlternatives")}</TableHead
            >
            <TableHead class="px-3 py-2 font-medium">{t("agentDecisions.colVersion")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each decisions as d (d.id)}
            <TableRow class="border-t border-kitsuden-border align-top" data-testid="decision-row">
              <TableCell class="px-3 py-2 whitespace-nowrap text-xs text-kitsuden-subtle"
                >{date(d.createdAt)}</TableCell
              >
              {#if !agentId}
                <TableCell class="px-3 py-2 whitespace-nowrap">
                  <a href="/agents/{d.agentId}" class="text-kitsuden-accent hover:underline"
                    >{d.agentName ?? d.agentId}</a
                  >
                </TableCell>
              {/if}
              <TableCell class="px-3 py-2 text-kitsuden-text">{d.action}</TableCell>
              <TableCell class="px-3 py-2 text-kitsuden-text-dim">{d.reason}</TableCell>
              <TableCell class="px-3 py-2 text-kitsuden-text-dim">
                {#each d.alternatives as a}<div>{a}</div>{/each}
              </TableCell>
              <TableCell class="px-3 py-2 text-xs text-kitsuden-subtle whitespace-nowrap">
                {d.version != null ? t("agentVersions.version", { n: d.version }) : ""}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
