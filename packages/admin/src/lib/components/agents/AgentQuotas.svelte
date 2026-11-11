<!--
  An agent's quotas: requests per minute, writes and budget
  in units per day (UTC), and what has been spent today. When exceeded, the API responds 429
  (KITSUDEN_E_RATE_LIMITED / KITSUDEN_E_QUOTA_EXCEEDED) with `retry_after`.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import Button from "$lib/components/ui/Button.svelte";
  import Card from "$lib/components/ui/Card.svelte";
  import { getAgentQuotas, setAgentQuotas } from "$lib/services/agents";
  import type { AgentQuotas } from "$lib/types/agents";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  let quotas = $state<AgentQuotas | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  // type="number": Svelte gives a number, or null if the field is left empty.
  let rpm = $state<number | null>(null);
  let writes = $state<number | null>(null);
  let units = $state<number | null>(null);

  onMount(load);

  function fill(c: AgentQuotas) {
    quotas = c;
    rpm = c.limits.requestsPerMinute;
    writes = c.limits.writesPerDay;
    units = c.limits.budgetUnitsPerDay;
  }

  async function load() {
    try {
      loading = true;
      error = null;
      fill(await getAgentQuotas(agentId));
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentQuotas.errorLoading");
    } finally {
      loading = false;
    }
  }

  /** Empty (or 0) = no limit. */
  const number = (v: number | null | undefined): number | null => (v ? Number(v) : null);

  async function save() {
    try {
      saving = true;
      fill(
        await setAgentQuotas(agentId, {
          ...(rpm ? { requestsPerMinute: Number(rpm) } : {}),
          writesPerDay: number(writes),
          budgetUnitsPerDay: number(units),
        })
      );
      toast.success(t("agentQuotas.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentQuotas.errorSaving"));
    } finally {
      saving = false;
    }
  }

  const integer = (n: number) => Math.round(n).toLocaleString();

  const percentage = (used: number, limit: number | null) =>
    limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  const STORE: Record<string, () => string> = {
    valkey: () => t("agentQuotas.storeValkey"),
    postgres: () => t("agentQuotas.storePostgres"),
    memory: () => t("agentQuotas.storeMemory"),
  };
</script>

<div class="space-y-4" data-testid="agent-quotas">
  <div>
    <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentQuotas.title")}</h3>
    <p class="text-xs text-kitsuden-subtle">{t("agentQuotas.help")}</p>
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
  {:else if quotas}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      {#each [{ id: "rpm", label: t("agentQuotas.requestsPerMinute"), used: quotas.usage.requestsThisMinute, limit: quotas.limits.requestsPerMinute, help: t("agentQuotas.requestsPerMinuteHelp") }, { id: "writes", label: t("agentQuotas.writesPerDay"), used: quotas.usage.writesToday, limit: quotas.limits.writesPerDay, help: t("agentQuotas.writesPerDayHelp") }, { id: "units", label: t("agentQuotas.unitsPerDay"), used: quotas.usage.unitsToday, limit: quotas.limits.budgetUnitsPerDay, help: t("agentQuotas.unitsPerDayHelp") }] as q (q.id)}
        <Card class="p-4 space-y-2 min-w-0">
          <div class="text-xs text-kitsuden-subtle">{q.label}</div>
          <div class="text-lg text-kitsuden-text">
            {q.limit
              ? t("agentQuotas.usedOf", { used: q.used, limit: q.limit })
              : t("agentQuotas.usedUnlimited", { used: q.used })}
          </div>
          <div class="h-1.5 rounded-sm bg-kitsuden-border overflow-hidden">
            <div
              class="h-full {percentage(q.used, q.limit) >= 90
                ? 'bg-kitsuden-danger'
                : 'bg-kitsuden-accent'}"
              style="width: {percentage(q.used, q.limit)}%"
            ></div>
          </div>
          <p class="text-[11px] text-kitsuden-subtle">{q.help}</p>
        </Card>
      {/each}
    </div>
    <p class="text-xs text-kitsuden-subtle">
      {t("agentQuotas.usageNote", {
        day: quotas.usage.day,
        store: STORE[quotas.usage.store]?.() ?? quotas.usage.store,
      })}
    </p>

    <!-- Savings of the auto format versus compact JSON (lib/format-savings.ts) -->
    <div class="space-y-2" data-testid="agent-format-savings">
      <div>
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentQuotas.savingsTitle")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("agentQuotas.savingsHelp")}</p>
      </div>
      {#if quotas.formatSavings === null}
        <p class="text-xs text-kitsuden-subtle">{t("agentQuotas.savingsUnavailable")}</p>
      {:else if !quotas.formatSavings || quotas.formatSavings.period.responses === 0}
        <p class="text-xs text-kitsuden-subtle">{t("agentQuotas.savingsNone")}</p>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each [{ id: "today", label: t("agentQuotas.savingsToday"), r: quotas.formatSavings.today }, { id: "period", label: t( "agentQuotas.savingsPeriod", { days: quotas.formatSavings.period.days } ), r: quotas.formatSavings.period }] as s (s.id)}
            <Card class="p-4 space-y-1 min-w-0">
              <div class="text-xs text-kitsuden-subtle">{s.label}</div>
              <div class="text-lg text-kitsuden-text">
                {t("agentQuotas.savingsTokens", {
                  saved: integer(s.r.savedTokensEst),
                  percent: s.r.savedPercent,
                })}
              </div>
              <p class="text-[11px] text-kitsuden-subtle">
                {t("agentQuotas.savingsBytes", {
                  saved: integer(s.r.savedBytes),
                  total: integer(s.r.jsonBytes),
                })}
              </p>
              <p class="text-[11px] text-kitsuden-subtle">
                {t("agentQuotas.savingsResponses", {
                  count: integer(s.r.responses),
                  compacted: integer(s.r.compacted),
                })}
              </p>
            </Card>
          {/each}
        </div>
      {/if}
    </div>

    <form
      class="grid grid-cols-1 md:grid-cols-3 gap-3 items-end"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div>
        <label for="q-rpm" class="block text-sm text-kitsuden-text mb-1.5"
          >{t("agentQuotas.requestsPerMinute")}</label
        >
        <input
          id="q-rpm"
          type="number"
          min="1"
          bind:value={rpm}
          class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        />
      </div>
      <div>
        <label for="q-writes" class="block text-sm text-kitsuden-text mb-1.5"
          >{t("agentQuotas.writesPerDay")}</label
        >
        <input
          id="q-writes"
          type="number"
          min="1"
          bind:value={writes}
          placeholder={t("agentQuotas.unlimited")}
          class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        />
      </div>
      <div>
        <label for="q-units" class="block text-sm text-kitsuden-text mb-1.5"
          >{t("agentQuotas.unitsPerDay")}</label
        >
        <input
          id="q-units"
          type="number"
          min="1"
          bind:value={units}
          placeholder={t("agentQuotas.unlimited")}
          class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        />
      </div>
      <div class="md:col-span-3 flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          <Save size={14} class="mr-1" />{t("agentQuotas.save")}
        </Button>
      </div>
    </form>
  {/if}
</div>
