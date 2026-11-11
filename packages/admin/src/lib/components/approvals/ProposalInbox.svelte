<!--
  Approval inbox: the agents' proposals, the detail with
  the diff and the decision (approve and run / reject, with a comment the
  agent will see). Only the human team gets here (the API requires it).
-->
<script lang="ts">
  import { nextPendingAfter } from "$lib/approvals-next";
  import StateMessage from "$lib/components/feedback/StateMessage.svelte";
  import { fieldDiffRedacted, readableFieldDiff } from "$lib/approvals-diff";
  import { t, localeFormat } from "$lib/i18n";
  import { Check, X, RefreshCw } from "lucide-svelte";
  import { onMount, untrack } from "svelte";
  import { toast } from "svelte-sonner";

  import Button from "$lib/components/ui/Button.svelte";
  import {
    approveProposal,
    getProposal,
    listProposals,
    proposalFileUrl,
    rejectProposal,
    scheduleReview,
    type DecisionExtra,
  } from "$lib/services/approvals";
  import { approvals } from "$lib/states/approvals.svelte";
  import type {
    FieldEvidence,
    Proposal,
    ProposalDetail,
    ProposalStatus,
  } from "$lib/types/approvals";

  interface Props {
    /** To open a specific proposal once, on mount (when nobody follows the selection). */
    initialId?: string | null;
    /**
     * The proposal the address names (`?id=`). With `onSelect` the inbox is controlled: it
     * shows this one and follows it when it changes (back/forward).
     */
    selectedId?: string | null;
    /** Asked to open a proposal (or none): the page writes it to `?id=`. */
    onSelect?: (id: string | null) => void;
  }
  const { initialId = null, selectedId = null, onSelect }: Props = $props();

  /** Opens a proposal: through the page (so the address changes) or directly. */
  function choose(id: string | null) {
    if (onSelect) onSelect(id);
    else void show(id);
  }

  async function show(id: string | null) {
    if (!id) {
      selection = null;
      return;
    }
    await open(id);
  }

  // Controlled: whatever `?id=` says is what is open, also after back/forward.
  $effect(() => {
    if (!onSelect) return;
    const id = selectedId;
    untrack(() => {
      if (id !== (selection?.id ?? null)) void show(id);
    });
  });

  const STATUSES: ProposalStatus[] = [
    "pending",
    "executing",
    "executed",
    "failed",
    "rejected",
    "expired",
  ];

  let filter = $state<ProposalStatus | "">("pending");
  let list = $state<Proposal[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selection = $state<ProposalDetail | null>(null);
  let loadingDetail = $state(false);
  let comment = $state("");
  let deciding = $state<"approve" | "reject" | null>(null);
  // Thumbnails of held images: file id → blob URL (or "error").
  let thumbnails = $state<Record<string, string>>({});
  // Agent data ledger: the reviewer's choice per field (accepted, and an optional new value).
  let fieldChoice = $state<Record<string, { accept: boolean; value: string }>>({});
  let reviewAt = $state("");
  let reviewNote = $state("");
  let scheduling = $state(false);

  function resetLedger(p: ProposalDetail | null) {
    const choice: Record<string, { accept: boolean; value: string }> = {};
    for (const f of readableFieldDiff(p)?.fields ?? [])
      choice[f.field] = { accept: true, value: "" };
    fieldChoice = choice;
    reviewAt = "";
    reviewNote = "";
  }

  /** A new value typed by the reviewer: JSON if it reads as JSON, else the text itself. */
  function typedValue(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function evidenceOf(p: ProposalDetail, field: string): FieldEvidence[] {
    return (p.evidence ?? []).filter((e) => e.field === field);
  }

  function decisionOf(p: ProposalDetail, field: string) {
    return p.fieldDecisions?.find((d) => d.field === field) ?? null;
  }

  const isUrl = (v: string) => /^https?:\/\//i.test(v);

  function decisionExtra(p: ProposalDetail, approving: boolean): DecisionExtra {
    const extra: DecisionExtra = {};
    // Everything accepted as proposed: no `fields`, the whole request runs. Any
    // rejection or edit: EVERY field is listed, since the API rejects a field
    // the list leaves out.
    if (approving && (readableFieldDiff(p)?.fields.length ?? 0) > 0) {
      const choices = Object.entries(fieldChoice);
      if (choices.some(([, c]) => !c.accept || c.value.trim() !== "")) {
        extra.fields = choices.map(([field, c]) =>
          !c.accept
            ? { field, decision: "reject" as const }
            : c.value.trim() !== ""
              ? { field, decision: "accept" as const, value: typedValue(c.value) }
              : { field, decision: "accept" as const }
        );
      }
    }
    if (reviewAt) {
      extra.reviewAt = new Date(reviewAt).toISOString();
      if (reviewNote.trim()) extra.reviewNote = reviewNote.trim();
    }
    return extra;
  }

  async function scheduleLater() {
    if (!selection || !reviewAt) return;
    try {
      scheduling = true;
      await scheduleReview(selection.id, {
        reviewAt: new Date(reviewAt).toISOString(),
        ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
      });
      toast.success(t("approvals.reviewScheduled"));
      await open(selection.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorDeciding"));
    } finally {
      scheduling = false;
    }
  }

  $effect(() => {
    const p = selection;
    const files = p?.files ?? [];
    const urls: string[] = [];
    let current = true;
    thumbnails = {};
    for (const f of files) {
      proposalFileUrl(p!.id, f.id)
        .then((url) => {
          urls.push(url);
          if (current) thumbnails = { ...thumbnails, [f.id]: url };
          else URL.revokeObjectURL(url);
        })
        .catch(() => {
          if (current) thumbnails = { ...thumbnails, [f.id]: "error" };
        });
    }
    return () => {
      current = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  });

  function size(bytes: number): string {
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  onMount(async () => {
    await load();
    if (!onSelect && initialId) await open(initialId);
  });

  async function load() {
    try {
      loading = true;
      error = null;
      const r = await listProposals({ status: filter, limit: 100 });
      list = r.proposals;
      total = r.total;
    } catch (e) {
      error = e instanceof Error ? e.message : t("approvals.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function open(id: string) {
    try {
      loadingDetail = true;
      comment = "";
      selection = await getProposal(id);
      resetLedger(selection);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorLoading"));
    } finally {
      loadingDetail = false;
    }
  }

  async function decide(action: "approve" | "reject") {
    if (!selection) return;
    // Where to go afterwards, from the list as the reviewer sees it now (it reloads below).
    const decidedId = selection.id;
    const next = nextPendingAfter(list, decidedId);
    try {
      deciding = action;
      const extra = decisionExtra(selection, action === "approve");
      const r =
        action === "approve"
          ? await approveProposal(selection.id, comment.trim() || undefined, extra)
          : await rejectProposal(selection.id, comment.trim() || undefined, {
              ...(extra.reviewAt ? { reviewAt: extra.reviewAt, reviewNote: extra.reviewNote } : {}),
            });
      selection = r.proposal;
      resetLedger(selection);
      if (action === "approve") {
        const status =
          r.proposal.status === "executed"
            ? t("approvals.status_executed")
            : t("approvals.status_failed");
        (r.proposal.status === "executed" ? toast.success : toast.error)(
          t("approvals.approved", { status: status })
        );
      } else {
        toast.success(t("approvals.rejected"));
      }
      await Promise.all([load(), approvals.refresh()]);
      // On to the next one that waits. The result of this one was just said in a toast;
      // with nothing left (or outside the pending queue) the decided proposal stays open.
      if (filter === "pending" && next) choose(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorDeciding"));
      await open(decidedId);
    } finally {
      deciding = null;
    }
  }

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
  const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

  const KIND: Record<ProposalStatus, string> = {
    pending: "bg-kitsuden-amber/15 text-kitsuden-amber",
    executing: "bg-kitsuden-info/15 text-kitsuden-info",
    executed: "bg-kitsuden-green/15 text-kitsuden-green",
    failed: "bg-kitsuden-danger/15 text-kitsuden-danger",
    rejected: "bg-kitsuden-muted/40 text-kitsuden-text",
    expired: "bg-kitsuden-muted/40 text-kitsuden-subtle",
  };
</script>

<div class="flex flex-col lg:flex-row gap-4 min-h-0" data-testid="approvals-inbox">
  <!-- List -->
  <section class="lg:w-[46%] min-w-0 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <label for="status-filter" class="text-xs text-kitsuden-subtle"
        >{t("approvals.filterStatus")}</label
      >
      <select
        id="status-filter"
        bind:value={filter}
        onchange={load}
        class="px-2 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        data-testid="status-filter"
      >
        <option value="">{t("approvals.all")}</option>
        {#each STATUSES as e}
          <option value={e}>{t(`approvals.status_${e}`)}</option>
        {/each}
      </select>
      <div class="flex-1"></div>
      <span class="text-xs text-kitsuden-subtle">{t("approvals.totalCount", { n: total })}</span>
      <Button variant="ghost" size="sm" onclick={load}>
        <RefreshCw size={14} class="mr-1" />{t("approvals.refresh")}
      </Button>
    </div>

    {#if loading}
      <div class="flex items-center justify-center h-24">
        <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-kitsuden-accent"></div>
      </div>
    {:else if error}
      <StateMessage
        kind="error"
        compact
        title={t("approvals.errorLoading")}
        description={error}
        onRetry={load}
      />
    {:else if list.length === 0}
      <StateMessage compact title={t("approvals.empty")} />
    {:else}
      <ul class="border border-kitsuden-border rounded-lg divide-y divide-kitsuden-border/70">
        {#each list as p (p.id)}
          <li>
            <button
              class="w-full text-left px-3 py-2.5 hover:bg-kitsuden-border/40 transition-colors {selection?.id ===
              p.id
                ? 'bg-kitsuden-border/60'
                : ''}"
              onclick={() => choose(p.id)}
              aria-current={selection?.id === p.id ? "true" : undefined}
              data-testid="proposal-row"
              data-proposal-id={p.id}
            >
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[11px] px-1.5 py-0.5 rounded-sm shrink-0 {KIND[p.status]}"
                  >{t(`approvals.status_${p.status}`)}</span
                >
                <code class="text-xs text-kitsuden-text truncate min-w-0"
                  >{p.method} {p.tool ?? p.path}</code
                >
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 text-[11px] text-kitsuden-subtle">
                <span>{p.agentName ?? t("approvals.agentDeleted")}</span>
                <span
                  >{p.channel === "mcp"
                    ? t("approvals.channelMcp")
                    : t("approvals.channelRest")}</span
                >
                <span>{t(`approvals.reason_${p.reason}`)}</span>
                <span>{date(p.createdAt)}</span>
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Detail -->
  <section class="flex-1 min-w-0" data-testid="proposal-detail">
    {#if loadingDetail}
      <div class="flex items-center justify-center h-24">
        <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-kitsuden-accent"></div>
      </div>
    {:else if !selection}
      <p class="text-sm text-kitsuden-subtle p-4">{t("approvals.selectHint")}</p>
    {:else}
      {@const s = selection}
      {@const diff = readableFieldDiff(s)}
      <div class="border border-kitsuden-border rounded-lg p-4 space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="text-[11px] px-1.5 py-0.5 rounded-sm {KIND[s.status]}"
            data-testid="detail-status">{t(`approvals.status_${s.status}`)}</span
          >
          <code class="text-sm text-kitsuden-text break-all">{s.method} {s.tool ?? s.path}</code>
        </div>

        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt class="text-kitsuden-subtle">{t("approvals.colAgent")}</dt>
            <dd class="text-kitsuden-text">{s.agentName ?? t("approvals.agentDeleted")}</dd>
          </div>
          <div data-testid="detail-sponsor">
            <dt class="text-kitsuden-subtle">{t("approvals.sponsor")}</dt>
            <dd class="text-kitsuden-text">
              {s.sponsorName ?? s.sponsorUserId ?? t("approvals.noSponsor")}
            </dd>
          </div>
          <div>
            <dt class="text-kitsuden-subtle">{t("approvals.reason")}</dt>
            <dd class="text-kitsuden-text">{t(`approvals.reason_${s.reason}`)}</dd>
          </div>
          <div>
            <dt class="text-kitsuden-subtle">{t("approvals.channel")}</dt>
            <dd class="text-kitsuden-text">
              {s.channel === "mcp" ? t("approvals.channelMcp") : t("approvals.channelRest")}
            </dd>
          </div>
          <div>
            <dt class="text-kitsuden-subtle">{t("approvals.operation")}</dt>
            <dd class="text-kitsuden-text break-all">
              {s.operation ?? s.tool ?? t("approvals.legacyRoute")}
            </dd>
          </div>
          <div>
            <dt class="text-kitsuden-subtle">{t("approvals.colCreated")}</dt>
            <dd class="text-kitsuden-text">{date(s.createdAt)}</dd>
          </div>
          <div>
            <dt class="text-kitsuden-subtle">{t("approvals.colExpires")}</dt>
            <dd class="text-kitsuden-text">{date(s.expiresAt)}</dd>
          </div>
          {#if s.idempotencyKey}
            <div class="sm:col-span-2">
              <dt class="text-kitsuden-subtle">{t("approvals.idempotencyKey")}</dt>
              <dd class="text-kitsuden-text break-all"><code>{s.idempotencyKey}</code></dd>
            </div>
          {/if}
          <div class="sm:col-span-2">
            <dt class="text-kitsuden-subtle">{t("approvals.scopes")}</dt>
            <dd class="flex flex-wrap gap-1 mt-1">
              {#each s.scopes as sc}
                <code
                  class="text-[11px] px-1.5 py-0.5 rounded-sm bg-kitsuden-border text-kitsuden-text"
                  >{sc}</code
                >
              {:else}
                <span class="text-kitsuden-subtle">—</span>
              {/each}
            </dd>
          </div>
        </dl>

        <!-- Diff -->
        {#if (s.files?.length ?? 0) > 0}
          <div data-testid="proposal-files">
            <h4 class="text-xs font-semibold text-kitsuden-text-dim mb-1.5">
              {t("approvals.files")}
            </h4>
            <ul class="flex flex-wrap gap-2">
              {#each s.files ?? [] as f (f.id)}
                <li class="w-32 text-[11px] text-kitsuden-text-dim">
                  <div
                    class="w-32 h-32 rounded-sm border border-kitsuden-border bg-kitsuden-bg flex items-center justify-center overflow-hidden"
                  >
                    {#if thumbnails[f.id] && thumbnails[f.id] !== "error"}
                      <img
                        src={thumbnails[f.id]}
                        alt={t("approvals.thumbnailAlt", { name: f.filename })}
                        class="max-w-full max-h-full object-contain"
                        data-testid="proposal-thumbnail"
                      />
                    {:else if thumbnails[f.id] === "error"}
                      <span class="px-2 text-center text-kitsuden-danger"
                        >{t("approvals.fileLoadError")}</span
                      >
                    {/if}
                  </div>
                  <p class="mt-1 truncate" title={f.filename}>{f.filename}</p>
                  <p class="text-kitsuden-subtle">{f.mimeType} · {size(f.size)}</p>
                </li>
              {/each}
            </ul>
          </div>
        {:else if s.contentType?.startsWith("multipart/")}
          <p class="text-xs text-kitsuden-subtle" data-testid="proposal-files-removed">
            {t("approvals.filesRemoved")}
          </p>
        {/if}

        {#if s.injectionCheck && /inject|unsafe|malicious|jailbreak/i.test(s.injectionCheck.label) && s.injectionCheck.score >= 0.5}
          <p
            class="text-xs px-3 py-2 rounded-sm bg-kitsuden-amber/10 border border-kitsuden-amber/20 text-kitsuden-amber"
            data-testid="proposal-injection"
          >
            {t("approvals.injectionWarning", {
              label: s.injectionCheck.label,
              score: s.injectionCheck.score.toFixed(2),
            })}
          </p>
        {/if}

        {#if fieldDiffRedacted(s)}
          <p class="text-xs text-kitsuden-subtle" data-testid="proposal-fields-redacted">
            {t("approvals.fieldsRedacted")}
          </p>
        {/if}
        {#if diff}
          {@const choosing = s.status === "pending" && s.canDecide}
          <div data-testid="proposal-fields">
            <h4 class="text-xs font-semibold text-kitsuden-text-dim mb-1.5">
              {t("approvals.fieldsTitle")}
            </h4>
            {#if diff.currentUnavailable !== undefined}
              <p class="text-xs text-kitsuden-amber mb-1.5">
                {t("approvals.diffUnavailable", { v: String(diff.currentUnavailable) })}
              </p>
            {/if}
            {#if diff.fields.length === 0}
              <p class="text-xs text-kitsuden-subtle">{t("approvals.noChanges")}</p>
            {:else}
              {#if choosing}
                <p class="text-[11px] text-kitsuden-subtle mb-1.5">{t("approvals.fieldsHint")}</p>
              {/if}
              <div class="overflow-x-auto border border-kitsuden-border rounded-sm">
                <table class="w-full text-xs">
                  <thead class="text-kitsuden-subtle">
                    <tr>
                      <th class="text-left px-2 py-1"
                        >{choosing ? t("approvals.fieldAccept") : t("approvals.fieldDecision")}</th
                      >
                      <th class="text-left px-2 py-1">{t("approvals.field")}</th>
                      <th class="text-left px-2 py-1">{t("approvals.before")}</th>
                      <th class="text-left px-2 py-1">{t("approvals.after")}</th>
                      <th class="text-left px-2 py-1">{t("approvals.evidence")}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-kitsuden-border/70">
                    {#each diff.fields as f (f.field)}
                      {@const decided = decisionOf(s, f.field)}
                      <tr data-testid="field-row" data-field={f.field}>
                        <td class="px-2 py-1 align-top">
                          {#if choosing && fieldChoice[f.field]}
                            <input
                              type="checkbox"
                              bind:checked={fieldChoice[f.field]!.accept}
                              aria-label={t("approvals.fieldAcceptAria", { field: f.field })}
                              data-testid="field-accept"
                            />
                          {:else if decided}
                            <span
                              class="text-[11px] px-1.5 py-0.5 rounded {decided.decision ===
                              'accept'
                                ? 'bg-kitsuden-green/15 text-kitsuden-green'
                                : 'bg-kitsuden-muted/40 text-kitsuden-text'}"
                            >
                              {decided.decision === "accept"
                                ? decided.edited
                                  ? t("approvals.fieldEdited")
                                  : t("approvals.fieldAccepted")
                                : t("approvals.fieldRejected")}
                            </span>
                          {:else}
                            <span class="text-kitsuden-subtle">—</span>
                          {/if}
                        </td>
                        <td class="px-2 py-1 text-kitsuden-text align-top">
                          <code>{f.field}</code>
                          {#if f.change === "remove"}
                            <span class="ml-1 text-xs text-kitsuden-danger"
                              >{t("approvals.fieldRemoved")}</span
                            >
                          {:else if f.change === "add"}
                            <span class="ml-1 text-xs text-kitsuden-green"
                              >{t("approvals.fieldAdded")}</span
                            >
                          {/if}
                        </td>
                        <td class="px-2 py-1 align-top"
                          ><pre class="whitespace-pre-wrap break-all text-kitsuden-danger">{json(
                              f.before
                            )}</pre></td
                        >
                        <td class="px-2 py-1 align-top">
                          <pre class="whitespace-pre-wrap break-all text-kitsuden-green">{json(
                              f.after
                            )}</pre>
                          {#if choosing && fieldChoice[f.field]?.accept}
                            <input
                              type="text"
                              bind:value={fieldChoice[f.field]!.value}
                              placeholder={t("approvals.fieldNewValue")}
                              aria-label={t("approvals.fieldNewValueAria", { field: f.field })}
                              class="mt-1 w-full px-2 py-1 bg-kitsuden-bg border border-kitsuden-input rounded-sm text-xs text-kitsuden-text"
                              data-testid="field-value"
                            />
                          {/if}
                        </td>
                        <td class="px-2 py-1 align-top text-kitsuden-text-dim">
                          {#each evidenceOf(s, f.field) as e}
                            <div class="mb-1" data-testid="field-evidence">
                              {#if isUrl(e.source)}
                                <a
                                  href={e.source}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  class="text-kitsuden-accent hover:underline break-all"
                                  >{e.source}</a
                                >
                              {:else}
                                <code class="break-all">{e.source}</code>
                              {/if}
                              {#if e.quote}
                                <p class="italic text-kitsuden-text">“{e.quote}”</p>
                              {/if}
                              <p class="text-xs text-kitsuden-subtle">
                                {#if e.confidence !== null}{t("approvals.evidenceConfidence", {
                                    n: String(Math.round(e.confidence * 100)),
                                  })}{/if}
                                {#if e.retrievedAt}
                                  · {t("approvals.evidenceRetrieved", {
                                    date: date(e.retrievedAt),
                                  })}{/if}
                              </p>
                            </div>
                          {:else}
                            <span class="text-kitsuden-subtle">{t("approvals.noEvidence")}</span>
                          {/each}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/if}

        <div data-testid="proposal-diff">
          <h4 class="text-xs font-semibold text-kitsuden-text-dim mb-1.5">{t("approvals.diff")}</h4>
          {#if !s.diff}
            <p class="text-xs text-kitsuden-subtle">{t("approvals.noDiff")}</p>
          {:else}
            {#if s.diff.currentUnavailable !== undefined}
              <p class="text-xs text-kitsuden-amber mb-1.5">
                {t("approvals.diffUnavailable", { v: String(s.diff.currentUnavailable) })}
              </p>
            {/if}
            {#if s.diff.changes}
              {#if s.diff.changes.length === 0}
                <p class="text-xs text-kitsuden-subtle">{t("approvals.noChanges")}</p>
              {:else}
                <div class="overflow-x-auto border border-kitsuden-border rounded-sm">
                  <table class="w-full text-xs">
                    <thead class="text-kitsuden-subtle">
                      <tr>
                        <th class="text-left px-2 py-1">{t("approvals.field")}</th>
                        <th class="text-left px-2 py-1">{t("approvals.before")}</th>
                        <th class="text-left px-2 py-1">{t("approvals.after")}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-kitsuden-border/70">
                      {#each s.diff.changes as change}
                        <tr>
                          <td class="px-2 py-1 text-kitsuden-text align-top"
                            ><code>{change.field}</code></td
                          >
                          <td class="px-2 py-1 align-top"
                            ><pre class="whitespace-pre-wrap break-all text-kitsuden-danger">{json(
                                change.before
                              )}</pre></td
                          >
                          <td class="px-2 py-1 align-top"
                            ><pre class="whitespace-pre-wrap break-all text-kitsuden-green">{json(
                                change.after
                              )}</pre></td
                          >
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            {:else if s.diff.kind === "delete" && s.diff.current != null}
              <p class="text-xs text-kitsuden-text-dim mb-1">{t("approvals.current")}</p>
              <pre
                class="text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-kitsuden-danger">{json(
                  s.diff.current
                )}</pre>
            {:else if s.diff.kind === "promotion"}
              <div class="text-xs text-kitsuden-text space-y-1" data-testid="proposal-promotion">
                <p>
                  {t("approvals.promotionSummary", {
                    action: s.diff.target?.slug ?? "—",
                    version: String(s.diff.versionNumber ?? "?"),
                    passed: String(s.diff.tests?.passed ?? 0),
                    total: String(s.diff.tests?.total ?? 0),
                    scan: s.diff.scan?.passed ? t("promotion.scanOk") : t("promotion.scanFail"),
                  })}
                </p>
                <ul class="list-disc ml-4 text-kitsuden-text-dim">
                  {#each s.diff.decision?.reasons ?? [] as m}<li>
                      {t(`promotion.reason_${m}`)}
                    </li>{/each}
                </ul>
                <a
                  href="/approvals?tab=promotion&version={s.diff.versionId}"
                  class="text-kitsuden-accent hover:underline">{t("approvals.openPromotion")}</a
                >
              </div>
            {:else if s.diff.kind === "tool"}
              <p class="text-xs text-kitsuden-text-dim mb-1">{t("approvals.arguments")}</p>
              <pre
                class="text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{json(
                  s.diff.arguments
                )}</pre>
            {:else}
              <p class="text-xs text-kitsuden-text-dim mb-1">{t("approvals.proposed")}</p>
              <pre
                class="text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-kitsuden-green">{json(
                  s.diff.proposed
                )}</pre>
            {/if}
          {/if}
        </div>

        <details>
          <summary class="text-xs text-kitsuden-text-dim cursor-pointer"
            >{t("approvals.body")}</summary
          >
          <pre
            class="mt-1.5 text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{json(
              s.body
            ) || "—"}</pre>
        </details>

        <!-- Decision -->
        {#if s.status === "pending"}
          {#if s.canDecide}
            <div class="space-y-2 border-t border-kitsuden-border pt-3">
              <label for="comment-input" class="block text-xs text-kitsuden-text-dim"
                >{t("approvals.comment")}</label
              >
              <textarea
                id="comment-input"
                bind:value={comment}
                rows={2}
                placeholder={t("approvals.commentPlaceholder")}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text resize-none"
              ></textarea>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label for="review-at" class="block text-xs text-kitsuden-text-dim"
                    >{t("approvals.reviewAt")}</label
                  >
                  <input
                    id="review-at"
                    type="datetime-local"
                    bind:value={reviewAt}
                    class="w-full px-2 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
                    data-testid="review-at"
                  />
                </div>
                <div>
                  <label for="review-note" class="block text-xs text-kitsuden-text-dim"
                    >{t("approvals.reviewNote")}</label
                  >
                  <input
                    id="review-note"
                    type="text"
                    bind:value={reviewNote}
                    placeholder={t("approvals.reviewNotePlaceholder")}
                    class="w-full px-2 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
                  />
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  loading={deciding === "reject"}
                  disabled={!!deciding}
                  onclick={() => decide("reject")}
                >
                  <X size={14} class="mr-1" />{t("approvals.reject")}
                </Button>
                <Button
                  variant="primary"
                  loading={deciding === "approve"}
                  disabled={!!deciding}
                  onclick={() => decide("approve")}
                >
                  <Check size={14} class="mr-1" />{t("approvals.approve")}
                </Button>
              </div>
            </div>
          {:else}
            <!-- They cannot approve it (they could not do it themselves), but rejecting executes nothing. -->
            <div class="space-y-2 border-t border-kitsuden-border pt-3">
              <p class="text-xs text-kitsuden-amber" data-testid="cannot-decide">
                {t("approvals.cannotDecide", {
                  reason: s.cannotDecideReason ? t(`approvals.why_${s.cannotDecideReason}`) : "",
                })}
              </p>
              <label for="comment-input" class="block text-xs text-kitsuden-text-dim"
                >{t("approvals.comment")}</label
              >
              <textarea
                id="comment-input"
                bind:value={comment}
                rows={2}
                placeholder={t("approvals.commentPlaceholder")}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text resize-none"
              ></textarea>
              <div class="flex justify-end">
                <Button
                  variant="secondary"
                  loading={deciding === "reject"}
                  disabled={!!deciding}
                  onclick={() => decide("reject")}
                >
                  <X size={14} class="mr-1" />{t("approvals.reject")}
                </Button>
              </div>
            </div>
          {/if}
        {:else}
          <div
            class="border-t border-kitsuden-border pt-3 space-y-2 text-xs"
            data-testid="proposal-decision"
          >
            {#if s.decidedBy}
              <p class="text-kitsuden-text-dim">
                {t("approvals.decidedBy", {
                  name: s.decidedByName ?? s.decidedBy,
                  date: date(s.decidedAt),
                })}
              </p>
            {/if}
            {#if s.comment}
              <p class="text-kitsuden-text">
                {t("approvals.commentShown", { comment: s.comment })}
              </p>
            {/if}
            {#if s.result}
              <div>
                <p class="text-kitsuden-text-dim mb-1">
                  {t("approvals.result")}
                  {#if s.result.status !== null}
                    <code class="ml-1 text-kitsuden-text" data-testid="result-status"
                      >{s.result.status}</code
                    >
                  {/if}
                </p>
                {#if s.result.error}
                  <p class="text-kitsuden-danger mb-1">
                    {t("approvals.resultError", { error: s.result.error })}
                  </p>
                {/if}
                <pre
                  class="bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{json(
                    s.result.body
                  ) || "—"}</pre>
              </div>
            {/if}
            {#if s.status === "executed" || s.status === "failed" || s.status === "rejected"}
              <div
                class="border-t border-kitsuden-border pt-2 space-y-2"
                data-testid="proposal-reviews"
              >
                <h4 class="text-xs font-semibold text-kitsuden-text-dim">
                  {t("approvals.reviewsTitle")}
                </h4>
                {#each s.reviews ?? [] as r (r.id)}
                  <p class="text-kitsuden-text">
                    {t(`approvals.reviewStatus_${r.status}`)} · {date(r.dueAt)}{#if r.note}
                      · {r.note}{/if}
                  </p>
                {:else}
                  <p class="text-kitsuden-subtle">{t("approvals.noReviews")}</p>
                {/each}
                <div class="flex flex-wrap items-end gap-2">
                  <div>
                    <label for="later-at" class="block text-kitsuden-text-dim"
                      >{t("approvals.reviewAt")}</label
                    >
                    <input
                      id="later-at"
                      type="datetime-local"
                      bind:value={reviewAt}
                      class="px-2 py-1 bg-kitsuden-bg border border-kitsuden-input rounded-sm text-xs text-kitsuden-text"
                    />
                  </div>
                  <div class="flex-1 min-w-40">
                    <label for="later-note" class="block text-kitsuden-text-dim"
                      >{t("approvals.reviewNote")}</label
                    >
                    <input
                      id="later-note"
                      type="text"
                      bind:value={reviewNote}
                      placeholder={t("approvals.reviewNotePlaceholder")}
                      class="w-full px-2 py-1 bg-kitsuden-bg border border-kitsuden-input rounded-sm text-xs text-kitsuden-text"
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={scheduling}
                    disabled={!reviewAt || scheduling}
                    onclick={scheduleLater}
                  >
                    {t("approvals.scheduleReview")}
                  </Button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>
