<!--
  Follow-up reviews of decided proposals (agent data ledger): the ones that are due
  first, each with its note and a link to its proposal. Marking one done closes it.
  The API is GET /api/approvals/reviews; see docs/agents/ledger.md.
-->
<script lang="ts">
  import { Alert, Badge, Button, EmptyState, Select, Skeleton } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";
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
    <label for="review-filter" class="text-xs text-kitsuden-subtle"
      >{t("approvals.reviewsFilter")}</label
    >
    <Select
      id="review-filter"
      width="auto"
      value={filter}
      onchange={(e: Event) => {
        filter = (e.currentTarget as HTMLSelectElement).value as Filter;
        void load();
      }}
      options={FILTERS.map((f) => ({ value: f, label: label(f) }))}
    />
    <div class="flex-1"></div>
    <Button variant="ghost" size="sm" onclick={load}>
      <RefreshCw size={14} aria-hidden="true" />{t("approvals.refresh")}
    </Button>
  </div>

  {#if loading}
    <Skeleton lines={3} />
  {:else if error}
    <Alert variant="error">{error}</Alert>
  {:else if list.length === 0}
    <EmptyState size="sm" icon="calendar" title={t("approvals.reviewsEmpty")} />
  {:else}
    <ul class="border border-kitsuden-border rounded-lg divide-y divide-kitsuden-border/70">
      {#each list as r (r.id)}
        <li class="px-3 py-2.5 text-xs space-y-1" data-testid="review-row">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant={r.status === "due" ? "warning" : "default"}
              >{t(`approvals.reviewStatus_${r.status}`)}</Badge
            >
            <span class="text-kitsuden-text"
              >{t("approvals.reviewDueOn", { date: date(r.dueAt) })}</span
            >
            <div class="flex-1"></div>
            <a
              href="/approvals?tab=inbox&id={r.proposalId}"
              class="text-kitsuden-accent hover:underline">{t("approvals.reviewOpen")}</a
            >
          </div>
          {#if r.note}
            <p class="text-kitsuden-text">{r.note}</p>
          {/if}
          {#if r.fields.length > 0}
            <p class="text-kitsuden-subtle">
              {t("approvals.reviewFields", { fields: r.fields.join(", ") })}
            </p>
          {/if}
          {#if r.doneComment}
            <p class="text-kitsuden-text-dim">
              {t("approvals.commentShown", { comment: r.doneComment })}
            </p>
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
