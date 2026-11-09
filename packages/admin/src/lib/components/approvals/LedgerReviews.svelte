<!--
  Follow-up reviews of decided proposals (agent data ledger): the ones that are due
  first, each with its note and a link to its proposal. Marking one done closes it.
  The API is GET /api/approvals/reviews; see docs/agents/ledger.md.
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw, CalendarClock } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import Button from "$lib/components/ui/Button.svelte";
  import { closeReview, listReviews } from "$lib/services/approvals";
  import type { LedgerReview } from "$lib/types/approvals";

  type Filter = "due" | "scheduled" | "done" | "cancelled" | "all";
  const FILTERS: Filter[] = ["due", "scheduled", "done", "cancelled", "all"];

  let filter = $state<Filter>("due");
  let list = $state<LedgerReview[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let closing = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      list = (await listReviews({ status: filter, limit: 200 })).reviews;
    } catch (e) {
      error = e instanceof Error ? e.message : t("approvals.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function close(r: LedgerReview, cancel: boolean) {
    try {
      closing = r.id;
      await closeReview(r.id, cancel ? { cancel: true } : {});
      toast.success(t("approvals.reviewClosed"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorDeciding"));
    } finally {
      closing = null;
    }
  }

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
  const label = (f: Filter) =>
    f === "all" ? t("approvals.reviewFilter_all") : t(`approvals.reviewStatus_${f}`);
</script>

<div class="max-w-4xl space-y-3" data-testid="ledger-reviews">
  <div class="flex flex-wrap items-center gap-2">
    <label for="review-filter" class="text-xs text-zinc-500">{t("approvals.reviewsFilter")}</label>
    <select
      id="review-filter"
      bind:value={filter}
      onchange={load}
      class="px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100"
    >
      {#each FILTERS as f}
        <option value={f}>{label(f)}</option>
      {/each}
    </select>
    <div class="flex-1"></div>
    <Button variant="ghost" size="sm" onclick={load}>
      <RefreshCw size={14} class="mr-1" />{t("approvals.refresh")}
    </Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if list.length === 0}
    <div class="p-8 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-lg">
      <CalendarClock size={20} class="mx-auto mb-2 text-zinc-600" />
      {t("approvals.reviewsEmpty")}
    </div>
  {:else}
    <ul class="border border-zinc-800 rounded-lg divide-y divide-zinc-800/70">
      {#each list as r (r.id)}
        <li class="px-3 py-2.5 text-xs space-y-1" data-testid="review-row">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="text-[11px] px-1.5 py-0.5 rounded {r.status === 'due'
                ? 'bg-amber-500/15 text-amber-300'
                : 'bg-zinc-700/40 text-zinc-300'}">{t(`approvals.reviewStatus_${r.status}`)}</span
            >
            <span class="text-zinc-300">{t("approvals.reviewDueOn", { date: date(r.dueAt) })}</span>
            <div class="flex-1"></div>
            <a href="/approvals?tab=inbox&id={r.proposalId}" class="text-indigo-300 hover:underline"
              >{t("approvals.reviewOpen")}</a
            >
          </div>
          {#if r.note}
            <p class="text-zinc-200">{r.note}</p>
          {/if}
          {#if r.fields.length > 0}
            <p class="text-zinc-500">
              {t("approvals.reviewFields", { fields: r.fields.join(", ") })}
            </p>
          {/if}
          {#if r.doneComment}
            <p class="text-zinc-400">{t("approvals.commentShown", { comment: r.doneComment })}</p>
          {/if}
          {#if r.status === "due" || r.status === "scheduled"}
            <div class="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={closing === r.id}
                onclick={() => close(r, true)}>{t("approvals.reviewCancel")}</Button
              >
              <Button
                variant="secondary"
                size="sm"
                loading={closing === r.id}
                disabled={closing === r.id}
                onclick={() => close(r, false)}>{t("approvals.reviewMarkDone")}</Button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
