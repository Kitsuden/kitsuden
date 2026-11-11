<!--
  Approval inbox: the agents' proposals, the detail with
  the diff and the decision (approve and run / reject, with a comment the
  agent will see). Only the human team gets here (the API requires it).
-->
<script lang="ts">
  import { fieldDiffRedacted, readableFieldDiff } from "$lib/approvals-diff";
  import { t, localeFormat } from "$lib/i18n";
  import { Check, X, RefreshCw, Inbox } from "lucide-svelte";
  import { onMount } from "svelte";
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
    /** To open a specific proposal (`?id=`). */
    initialId?: string | null;
  }
  const { initialId = null }: Props = $props();

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
    if (initialId) await open(initialId);
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorDeciding"));
      await open(selection.id);
    } finally {
      deciding = null;
    }
  }

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
  const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

  const KIND: Record<ProposalStatus, string> = {
    pending: "bg-amber-500/15 text-amber-300",
    executing: "bg-sky-500/15 text-sky-300",
    executed: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-red-500/15 text-red-300",
    rejected: "bg-zinc-700/40 text-zinc-300",
    expired: "bg-zinc-700/40 text-zinc-500",
  };
</script>

<div class="flex flex-col lg:flex-row gap-4 min-h-0" data-testid="approvals-inbox">
  <!-- List -->
  <section class="lg:w-[46%] min-w-0 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <label for="status-filter" class="text-xs text-zinc-500">{t("approvals.filterStatus")}</label>
      <select
        id="status-filter"
        bind:value={filter}
        onchange={load}
        class="px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100"
        data-testid="status-filter"
      >
        <option value="">{t("approvals.all")}</option>
        {#each STATUSES as e}
          <option value={e}>{t(`approvals.status_${e}`)}</option>
        {/each}
      </select>
      <div class="flex-1"></div>
      <span class="text-xs text-zinc-500">{t("approvals.totalCount", { n: total })}</span>
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
        <Inbox size={20} class="mx-auto mb-2 text-zinc-600" />
        {t("approvals.empty")}
      </div>
    {:else}
      <ul class="border border-zinc-800 rounded-lg divide-y divide-zinc-800/70">
        {#each list as p (p.id)}
          <li>
            <button
              class="w-full text-left px-3 py-2.5 hover:bg-zinc-800/40 transition-colors {selection?.id ===
              p.id
                ? 'bg-zinc-800/60'
                : ''}"
              onclick={() => open(p.id)}
              data-testid="proposal-row"
              data-proposal-id={p.id}
            >
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[11px] px-1.5 py-0.5 rounded-sm shrink-0 {KIND[p.status]}"
                  >{t(`approvals.status_${p.status}`)}</span
                >
                <code class="text-xs text-zinc-300 truncate min-w-0"
                  >{p.method} {p.tool ?? p.path}</code
                >
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 text-[11px] text-zinc-500">
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
        <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
      </div>
    {:else if !selection}
      <p class="text-sm text-zinc-500 p-4">{t("approvals.selectHint")}</p>
    {:else}
      {@const s = selection}
      {@const diff = readableFieldDiff(s)}
      <div class="border border-zinc-800 rounded-lg p-4 space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="text-[11px] px-1.5 py-0.5 rounded-sm {KIND[s.status]}"
            data-testid="detail-status">{t(`approvals.status_${s.status}`)}</span
          >
          <code class="text-sm text-zinc-100 break-all">{s.method} {s.tool ?? s.path}</code>
        </div>

        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt class="text-zinc-500">{t("approvals.colAgent")}</dt>
            <dd class="text-zinc-200">{s.agentName ?? t("approvals.agentDeleted")}</dd>
          </div>
          <div data-testid="detail-sponsor">
            <dt class="text-zinc-500">{t("approvals.sponsor")}</dt>
            <dd class="text-zinc-200">
              {s.sponsorName ?? s.sponsorUserId ?? t("approvals.noSponsor")}
            </dd>
          </div>
          <div>
            <dt class="text-zinc-500">{t("approvals.reason")}</dt>
            <dd class="text-zinc-200">{t(`approvals.reason_${s.reason}`)}</dd>
          </div>
          <div>
            <dt class="text-zinc-500">{t("approvals.channel")}</dt>
            <dd class="text-zinc-200">
              {s.channel === "mcp" ? t("approvals.channelMcp") : t("approvals.channelRest")}
            </dd>
          </div>
          <div>
            <dt class="text-zinc-500">{t("approvals.operation")}</dt>
            <dd class="text-zinc-200 break-all">
              {s.operation ?? s.tool ?? t("approvals.legacyRoute")}
            </dd>
          </div>
          <div>
            <dt class="text-zinc-500">{t("approvals.colCreated")}</dt>
            <dd class="text-zinc-200">{date(s.createdAt)}</dd>
          </div>
          <div>
            <dt class="text-zinc-500">{t("approvals.colExpires")}</dt>
            <dd class="text-zinc-200">{date(s.expiresAt)}</dd>
          </div>
          {#if s.idempotencyKey}
            <div class="sm:col-span-2">
              <dt class="text-zinc-500">{t("approvals.idempotencyKey")}</dt>
              <dd class="text-zinc-200 break-all"><code>{s.idempotencyKey}</code></dd>
            </div>
          {/if}
          <div class="sm:col-span-2">
            <dt class="text-zinc-500">{t("approvals.scopes")}</dt>
            <dd class="flex flex-wrap gap-1 mt-1">
              {#each s.scopes as sc}
                <code class="text-[11px] px-1.5 py-0.5 rounded-sm bg-zinc-800 text-zinc-300"
                  >{sc}</code
                >
              {:else}
                <span class="text-zinc-500">—</span>
              {/each}
            </dd>
          </div>
        </dl>

        <!-- Diff -->
        {#if (s.files?.length ?? 0) > 0}
          <div data-testid="proposal-files">
            <h4 class="text-xs font-semibold text-zinc-400 mb-1.5">{t("approvals.files")}</h4>
            <ul class="flex flex-wrap gap-2">
              {#each s.files ?? [] as f (f.id)}
                <li class="w-32 text-[11px] text-zinc-400">
                  <div
                    class="w-32 h-32 rounded-sm border border-zinc-800 bg-zinc-950 flex items-center justify-center overflow-hidden"
                  >
                    {#if thumbnails[f.id] && thumbnails[f.id] !== "error"}
                      <img
                        src={thumbnails[f.id]}
                        alt={t("approvals.thumbnailAlt", { name: f.filename })}
                        class="max-w-full max-h-full object-contain"
                        data-testid="proposal-thumbnail"
                      />
                    {:else if thumbnails[f.id] === "error"}
                      <span class="px-2 text-center text-red-300/80"
                        >{t("approvals.fileLoadError")}</span
                      >
                    {/if}
                  </div>
                  <p class="mt-1 truncate" title={f.filename}>{f.filename}</p>
                  <p class="text-zinc-500">{f.mimeType} · {size(f.size)}</p>
                </li>
              {/each}
            </ul>
          </div>
        {:else if s.contentType?.startsWith("multipart/")}
          <p class="text-xs text-zinc-500" data-testid="proposal-files-removed">
            {t("approvals.filesRemoved")}
          </p>
        {/if}

        {#if s.injectionCheck && /inject|unsafe|malicious|jailbreak/i.test(s.injectionCheck.label) && s.injectionCheck.score >= 0.5}
          <p
            class="text-xs px-3 py-2 rounded-sm bg-amber-500/10 border border-amber-500/20 text-amber-300"
            data-testid="proposal-injection"
          >
            {t("approvals.injectionWarning", {
              label: s.injectionCheck.label,
              score: s.injectionCheck.score.toFixed(2),
            })}
          </p>
        {/if}

        {#if fieldDiffRedacted(s)}
          <p class="text-xs text-zinc-500" data-testid="proposal-fields-redacted">
            {t("approvals.fieldsRedacted")}
          </p>
        {/if}
        {#if diff}
          {@const choosing = s.status === "pending" && s.canDecide}
          <div data-testid="proposal-fields">
            <h4 class="text-xs font-semibold text-zinc-400 mb-1.5">{t("approvals.fieldsTitle")}</h4>
            {#if diff.currentUnavailable !== undefined}
              <p class="text-xs text-amber-300/80 mb-1.5">
                {t("approvals.diffUnavailable", { v: String(diff.currentUnavailable) })}
              </p>
            {/if}
            {#if diff.fields.length === 0}
              <p class="text-xs text-zinc-500">{t("approvals.noChanges")}</p>
            {:else}
              {#if choosing}
                <p class="text-[11px] text-zinc-500 mb-1.5">{t("approvals.fieldsHint")}</p>
              {/if}
              <div class="overflow-x-auto border border-zinc-800 rounded-sm">
                <table class="w-full text-xs">
                  <thead class="text-zinc-500">
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
                  <tbody class="divide-y divide-zinc-800/70">
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
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-zinc-700/40 text-zinc-300'}"
                            >
                              {decided.decision === "accept"
                                ? decided.edited
                                  ? t("approvals.fieldEdited")
                                  : t("approvals.fieldAccepted")
                                : t("approvals.fieldRejected")}
                            </span>
                          {:else}
                            <span class="text-zinc-600">—</span>
                          {/if}
                        </td>
                        <td class="px-2 py-1 text-zinc-300 align-top">
                          <code>{f.field}</code>
                          {#if f.change === "remove"}
                            <span class="ml-1 text-[10px] text-red-300/80"
                              >{t("approvals.fieldRemoved")}</span
                            >
                          {:else if f.change === "add"}
                            <span class="ml-1 text-[10px] text-emerald-300/80"
                              >{t("approvals.fieldAdded")}</span
                            >
                          {/if}
                        </td>
                        <td class="px-2 py-1 align-top"
                          ><pre class="whitespace-pre-wrap break-all text-red-300/90">{json(
                              f.before
                            )}</pre></td
                        >
                        <td class="px-2 py-1 align-top">
                          <pre class="whitespace-pre-wrap break-all text-emerald-300/90">{json(
                              f.after
                            )}</pre>
                          {#if choosing && fieldChoice[f.field]?.accept}
                            <input
                              type="text"
                              bind:value={fieldChoice[f.field]!.value}
                              placeholder={t("approvals.fieldNewValue")}
                              aria-label={t("approvals.fieldNewValueAria", { field: f.field })}
                              class="mt-1 w-full px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-sm text-xs text-zinc-100"
                              data-testid="field-value"
                            />
                          {/if}
                        </td>
                        <td class="px-2 py-1 align-top text-zinc-400">
                          {#each evidenceOf(s, f.field) as e}
                            <div class="mb-1" data-testid="field-evidence">
                              {#if isUrl(e.source)}
                                <a
                                  href={e.source}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  class="text-indigo-300 hover:underline break-all">{e.source}</a
                                >
                              {:else}
                                <code class="break-all">{e.source}</code>
                              {/if}
                              {#if e.quote}
                                <p class="italic text-zinc-300">“{e.quote}”</p>
                              {/if}
                              <p class="text-[10px] text-zinc-500">
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
                            <span class="text-zinc-600">{t("approvals.noEvidence")}</span>
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
          <h4 class="text-xs font-semibold text-zinc-400 mb-1.5">{t("approvals.diff")}</h4>
          {#if !s.diff}
            <p class="text-xs text-zinc-500">{t("approvals.noDiff")}</p>
          {:else}
            {#if s.diff.currentUnavailable !== undefined}
              <p class="text-xs text-amber-300/80 mb-1.5">
                {t("approvals.diffUnavailable", { v: String(s.diff.currentUnavailable) })}
              </p>
            {/if}
            {#if s.diff.changes}
              {#if s.diff.changes.length === 0}
                <p class="text-xs text-zinc-500">{t("approvals.noChanges")}</p>
              {:else}
                <div class="overflow-x-auto border border-zinc-800 rounded-sm">
                  <table class="w-full text-xs">
                    <thead class="text-zinc-500">
                      <tr>
                        <th class="text-left px-2 py-1">{t("approvals.field")}</th>
                        <th class="text-left px-2 py-1">{t("approvals.before")}</th>
                        <th class="text-left px-2 py-1">{t("approvals.after")}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-zinc-800/70">
                      {#each s.diff.changes as change}
                        <tr>
                          <td class="px-2 py-1 text-zinc-300 align-top"
                            ><code>{change.field}</code></td
                          >
                          <td class="px-2 py-1 align-top"
                            ><pre class="whitespace-pre-wrap break-all text-red-300/90">{json(
                                change.before
                              )}</pre></td
                          >
                          <td class="px-2 py-1 align-top"
                            ><pre class="whitespace-pre-wrap break-all text-emerald-300/90">{json(
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
              <p class="text-xs text-zinc-400 mb-1">{t("approvals.current")}</p>
              <pre
                class="text-xs bg-zinc-950 border border-zinc-800 rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-red-300/90">{json(
                  s.diff.current
                )}</pre>
            {:else if s.diff.kind === "promotion"}
              <div class="text-xs text-zinc-300 space-y-1" data-testid="proposal-promotion">
                <p>
                  {t("approvals.promotionSummary", {
                    action: s.diff.target?.slug ?? "—",
                    version: String(s.diff.versionNumber ?? "?"),
                    passed: String(s.diff.tests?.passed ?? 0),
                    total: String(s.diff.tests?.total ?? 0),
                    scan: s.diff.scan?.passed ? t("promotion.scanOk") : t("promotion.scanFail"),
                  })}
                </p>
                <ul class="list-disc ml-4 text-zinc-400">
                  {#each s.diff.decision?.reasons ?? [] as m}<li>
                      {t(`promotion.reason_${m}`)}
                    </li>{/each}
                </ul>
                <a
                  href="/approvals?tab=promotion&version={s.diff.versionId}"
                  class="text-indigo-300 hover:underline">{t("approvals.openPromotion")}</a
                >
              </div>
            {:else if s.diff.kind === "tool"}
              <p class="text-xs text-zinc-400 mb-1">{t("approvals.arguments")}</p>
              <pre
                class="text-xs bg-zinc-950 border border-zinc-800 rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{json(
                  s.diff.arguments
                )}</pre>
            {:else}
              <p class="text-xs text-zinc-400 mb-1">{t("approvals.proposed")}</p>
              <pre
                class="text-xs bg-zinc-950 border border-zinc-800 rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-emerald-300/90">{json(
                  s.diff.proposed
                )}</pre>
            {/if}
          {/if}
        </div>

        <details>
          <summary class="text-xs text-zinc-400 cursor-pointer">{t("approvals.body")}</summary>
          <pre
            class="mt-1.5 text-xs bg-zinc-950 border border-zinc-800 rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{json(
              s.body
            ) || "—"}</pre>
        </details>

        <!-- Decision -->
        {#if s.status === "pending"}
          {#if s.canDecide}
            <div class="space-y-2 border-t border-zinc-800 pt-3">
              <label for="comment-input" class="block text-xs text-zinc-400"
                >{t("approvals.comment")}</label
              >
              <textarea
                id="comment-input"
                bind:value={comment}
                rows={2}
                placeholder={t("approvals.commentPlaceholder")}
                class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 resize-none"
              ></textarea>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label for="review-at" class="block text-xs text-zinc-400"
                    >{t("approvals.reviewAt")}</label
                  >
                  <input
                    id="review-at"
                    type="datetime-local"
                    bind:value={reviewAt}
                    class="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100"
                    data-testid="review-at"
                  />
                </div>
                <div>
                  <label for="review-note" class="block text-xs text-zinc-400"
                    >{t("approvals.reviewNote")}</label
                  >
                  <input
                    id="review-note"
                    type="text"
                    bind:value={reviewNote}
                    placeholder={t("approvals.reviewNotePlaceholder")}
                    class="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100"
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
            <div class="space-y-2 border-t border-zinc-800 pt-3">
              <p class="text-xs text-amber-300/80" data-testid="cannot-decide">
                {t("approvals.cannotDecide", {
                  reason: s.cannotDecideReason ? t(`approvals.why_${s.cannotDecideReason}`) : "",
                })}
              </p>
              <label for="comment-input" class="block text-xs text-zinc-400"
                >{t("approvals.comment")}</label
              >
              <textarea
                id="comment-input"
                bind:value={comment}
                rows={2}
                placeholder={t("approvals.commentPlaceholder")}
                class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 resize-none"
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
            class="border-t border-zinc-800 pt-3 space-y-2 text-xs"
            data-testid="proposal-decision"
          >
            {#if s.decidedBy}
              <p class="text-zinc-400">
                {t("approvals.decidedBy", {
                  name: s.decidedByName ?? s.decidedBy,
                  date: date(s.decidedAt),
                })}
              </p>
            {/if}
            {#if s.comment}
              <p class="text-zinc-300">{t("approvals.commentShown", { comment: s.comment })}</p>
            {/if}
            {#if s.result}
              <div>
                <p class="text-zinc-400 mb-1">
                  {t("approvals.result")}
                  {#if s.result.status !== null}
                    <code class="ml-1 text-zinc-200" data-testid="result-status"
                      >{s.result.status}</code
                    >
                  {/if}
                </p>
                {#if s.result.error}
                  <p class="text-red-300 mb-1">
                    {t("approvals.resultError", { error: s.result.error })}
                  </p>
                {/if}
                <pre
                  class="bg-zinc-950 border border-zinc-800 rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{json(
                    s.result.body
                  ) || "—"}</pre>
              </div>
            {/if}
            {#if s.status === "executed" || s.status === "failed" || s.status === "rejected"}
              <div class="border-t border-zinc-800 pt-2 space-y-2" data-testid="proposal-reviews">
                <h4 class="text-xs font-semibold text-zinc-400">{t("approvals.reviewsTitle")}</h4>
                {#each s.reviews ?? [] as r (r.id)}
                  <p class="text-zinc-300">
                    {t(`approvals.reviewStatus_${r.status}`)} · {date(r.dueAt)}{#if r.note}
                      · {r.note}{/if}
                  </p>
                {:else}
                  <p class="text-zinc-500">{t("approvals.noReviews")}</p>
                {/each}
                <div class="flex flex-wrap items-end gap-2">
                  <div>
                    <label for="later-at" class="block text-zinc-400"
                      >{t("approvals.reviewAt")}</label
                    >
                    <input
                      id="later-at"
                      type="datetime-local"
                      bind:value={reviewAt}
                      class="px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-sm text-xs text-zinc-100"
                    />
                  </div>
                  <div class="flex-1 min-w-40">
                    <label for="later-note" class="block text-zinc-400"
                      >{t("approvals.reviewNote")}</label
                    >
                    <input
                      id="later-note"
                      type="text"
                      bind:value={reviewNote}
                      placeholder={t("approvals.reviewNotePlaceholder")}
                      class="w-full px-2 py-1 bg-zinc-950 border border-zinc-800 rounded-sm text-xs text-zinc-100"
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
