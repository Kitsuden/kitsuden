<!--
  Approval inbox: the agents' proposals on the left, the open one on the right as a tallao
  ApprovalCard (who asks, what would happen, the field changes as a DiffView, the decision).
  Only the human team gets here (the API requires it).

  Keyboard (shown as hints over the list; off while typing or with a dialog in front):
    j / k   next / previous proposal        a   approve and run        r   reject
  After a decision the inbox moves on to the next proposal that waits. Pending proposals can
  be checked and approved together ("Approve selected"); each one still runs on its own and
  the result says how many ran and how many failed.

  What the card cannot hold stays inside it as its content: the per-field ledger (accept or
  reject each field, type another value, read the evidence), held uploads, the request, the
  comment the agent will see and the later review.
-->
<script lang="ts">
  import { RefreshCw } from "lucide-svelte";
  import { onMount, untrack } from "svelte";

  import {
    approvalCardProps,
    bulkApprovable,
    bulkSummary,
    inboxKeyAction,
    type CardProposal,
  } from "$lib/agents/inbox";
  import { fieldDiffRedacted, readableFieldDiff } from "$lib/approvals-diff";
  import { nextPendingAfter } from "$lib/approvals-next";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t } from "$lib/i18n";
  import { formatDateTime } from "$lib/utils";
  import { isTypingTarget } from "$lib/palette";
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
  import {
    Alert,
    ApprovalCard,
    Badge,
    Button,
    Checkbox,
    DescriptionList,
    EmptyState,
    Field,
    Input,
    Kbd,
    Select,
    SelectionBar,
    Skeleton,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
    toast,
    type DescriptionItem,
  } from "$lib/tallao";
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
  const STATUS_LABEL: Record<ProposalStatus, () => string> = {
    pending: () => t("approvals.status_pending"),
    executing: () => t("approvals.status_executing"),
    executed: () => t("approvals.status_executed"),
    failed: () => t("approvals.status_failed"),
    rejected: () => t("approvals.status_rejected"),
    expired: () => t("approvals.status_expired"),
  };
  const STATUS_VARIANT: Record<
    ProposalStatus,
    "warning" | "info" | "success" | "error" | "default"
  > = {
    pending: "warning",
    executing: "info",
    executed: "success",
    failed: "error",
    rejected: "default",
    expired: "default",
  };

  let filter = $state<string>("pending");
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
  /** Proposals checked for a bulk approval. */
  let checked = $state<string[]>([]);
  let bulkBusy = $state(false);

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
      const r = await listProposals({ status: filter as ProposalStatus | "", limit: 100 });
      list = r.proposals;
      total = r.total;
      // A check on a proposal that left the list (decided, filtered out) is dropped.
      const ids = new Set(bulkApprovable(list, checked).map((p) => p.id));
      checked = checked.filter((id) => ids.has(id));
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
    if (!selection || deciding) return;
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

  // ── Bulk approval ────────────────────────────────────────────────────────────────
  const checkable = $derived(list.filter((p) => p.status === "pending"));

  function toggle(id: string, on: boolean) {
    checked = on ? [...new Set([...checked, id])] : checked.filter((c) => c !== id);
  }

  async function approveChecked() {
    const targets = bulkApprovable(list, checked);
    if (targets.length === 0 || bulkBusy) return;
    const ok = await confirmDialog({
      title: t("inbox.bulkTitle", { n: targets.length }),
      description: t("inbox.bulkDescription"),
      confirmLabel: t("inbox.bulkConfirm"),
      variant: "primary",
    });
    if (!ok) return;
    bulkBusy = true;
    // One after another: each approval runs its request, and the order is the list's.
    const results: Array<"executed" | "failed" | "error"> = [];
    for (const p of targets) {
      try {
        const r = await approveProposal(p.id, undefined, {});
        results.push(r.proposal.status === "executed" ? "executed" : "failed");
      } catch {
        results.push("error");
      }
    }
    bulkBusy = false;
    const { executed, failed } = bulkSummary(results);
    if (executed > 0) toast.success(t("inbox.bulkDone", { n: executed }));
    if (failed > 0) toast.error(t("inbox.bulkFailed", { n: failed }));
    checked = [];
    await Promise.all([load(), approvals.refresh()]);
    if (selection) await open(selection.id);
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────────
  const waiting = $derived(selection?.status === "pending" && !deciding && !loadingDetail);

  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    const action = inboxKeyAction(event, {
      ids: list.map((p) => p.id),
      currentId: selection?.id ?? null,
      canApprove: !!waiting && selection?.canDecide === true,
      canReject: !!waiting,
      blocked: isTypingTarget(event.target) || !!document.querySelector("dialog[open]"),
    });
    if (!action) return;
    event.preventDefault();
    if (action.type === "move") {
      choose(action.id);
      document
        .querySelector(`[data-proposal-id="${CSS.escape(action.id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else void decide(action.type);
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  // The panel's one way of writing a moment (see $lib/utils).
  const date = formatDateTime;
  const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

  const reasonLabel = (reason: string) =>
    reason === "propose_only"
      ? t("approvals.reason_propose_only")
      : t("approvals.reason_sensitive");
  const channelLabel = (channel: string) =>
    channel === "mcp" ? t("approvals.channelMcp") : t("approvals.channelRest");

  function aboutItems(s: ProposalDetail): DescriptionItem[] {
    return [
      {
        label: t("approvals.sponsor"),
        value: s.sponsorName ?? s.sponsorUserId ?? t("approvals.noSponsor"),
      },
      { label: t("approvals.reason"), value: reasonLabel(s.reason) },
      { label: t("approvals.channel"), value: channelLabel(s.channel) },
      {
        label: t("approvals.operation"),
        value: s.operation ?? s.tool ?? t("approvals.legacyRoute"),
        mono: true,
      },
      { label: t("inbox.request"), value: `${s.method} ${s.path}`, mono: true },
      { label: t("approvals.colCreated"), value: date(s.createdAt) },
      { label: t("approvals.colExpires"), value: date(s.expiresAt) },
      ...(s.idempotencyKey
        ? [{ label: t("approvals.idempotencyKey"), value: s.idempotencyKey, mono: true }]
        : []),
      {
        label: t("approvals.scopes"),
        value: s.scopes.length > 0 ? s.scopes.join("  ") : null,
        mono: true,
      },
    ];
  }
</script>

<div class="inbox" data-testid="approvals-inbox">
  <!-- List -->
  <section class="inbox-list">
    <div class="inbox-toolbar">
      <Field label={t("approvals.filterStatus")} class="inbox-filter">
        <Select
          bind:value={filter}
          onchange={load}
          size="sm"
          width="auto"
          data-testid="status-filter"
          options={[
            { value: "", label: t("approvals.all") },
            ...STATUSES.map((value) => ({ value, label: STATUS_LABEL[value]() })),
          ]}
        />
      </Field>
      <span class="inbox-count">{t("approvals.totalCount", { n: total })}</span>
      <Button variant="ghost" size="sm" onclick={load}>
        <RefreshCw size={14} aria-hidden="true" />{t("approvals.refresh")}
      </Button>
    </div>

    <p class="inbox-keys" data-testid="inbox-keys">
      <span><Kbd keys={["j"]} size="sm" /> <Kbd keys={["k"]} size="sm" /> {t("inbox.keyMove")}</span
      >
      <span><Kbd keys={["a"]} size="sm" /> {t("inbox.keyApprove")}</span>
      <span><Kbd keys={["r"]} size="sm" /> {t("inbox.keyReject")}</span>
    </p>

    {#if checked.length > 0}
      <SelectionBar
        total={checkable.length}
        selected={checked.length}
        onToggleAll={(on) => (checked = on ? checkable.map((p) => p.id) : [])}
        ariaLabel={t("list.bulkActions")}
      >
        {#snippet actions()}
          <Button
            size="sm"
            loading={bulkBusy}
            disabled={bulkBusy}
            onclick={approveChecked}
            data-testid="bulk-approve"
          >
            {t("inbox.approveSelected")}
          </Button>
        {/snippet}
      </SelectionBar>
    {/if}

    {#if loading && list.length === 0}
      <div role="status" aria-busy="true">
        <span class="sr-only">{t("common.loading")}</span>
        <Skeleton lines={5} />
      </div>
    {:else if error}
      <EmptyState
        variant="error"
        size="sm"
        title={t("approvals.errorLoading")}
        description={error}
        onRetry={load}
      />
    {:else if list.length === 0}
      <EmptyState size="sm" title={t("approvals.empty")} description={t("inbox.emptyHint")} />
    {:else}
      <ul class="inbox-rows">
        {#each list as p (p.id)}
          <li class="inbox-row" class:inbox-row--current={selection?.id === p.id}>
            <span class="inbox-check">
              {#if p.status === "pending"}
                <Checkbox
                  checked={checked.includes(p.id)}
                  onchange={(e: Event) =>
                    toggle(p.id, (e.currentTarget as HTMLInputElement).checked)}
                  ariaLabel={t("inbox.selectOne", { name: `${p.method} ${p.tool ?? p.path}` })}
                />
              {/if}
            </span>
            <button
              type="button"
              class="inbox-open"
              onclick={() => choose(p.id)}
              aria-current={selection?.id === p.id ? "true" : undefined}
              data-testid="proposal-row"
              data-proposal-id={p.id}
            >
              <span class="inbox-row-top">
                <Badge variant={STATUS_VARIANT[p.status]} size="sm"
                  >{STATUS_LABEL[p.status]()}</Badge
                >
                <code class="inbox-target">{p.method} {p.tool ?? p.path}</code>
              </span>
              <span class="inbox-row-meta">
                <span>{p.agentName ?? t("approvals.agentDeleted")}</span>
                <span>{channelLabel(p.channel)}</span>
                <span>{reasonLabel(p.reason)}</span>
                <span>{date(p.createdAt)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Detail -->
  <section class="inbox-detail" data-testid="proposal-detail">
    {#if loadingDetail && !selection}
      <div role="status" aria-busy="true">
        <span class="sr-only">{t("common.loading")}</span>
        <Skeleton lines={8} />
      </div>
    {:else if !selection}
      <EmptyState size="sm" icon={false} title={t("approvals.selectHint")} />
    {:else}
      {@const s = selection}
      {@const diff = readableFieldDiff(s)}
      {@const card = approvalCardProps(s as unknown as CardProposal, t, date, { ledger: !!diff })}
      {@const pending = s.status === "pending"}
      {#key s.id}
        <ApprovalCard
          title={card.title}
          requester={card.requester}
          status={card.status}
          outcome={card.outcome}
          changes={card.changes}
          tool={card.tool}
          args={card.args}
          risk={card.risk}
          riskLevel={card.riskLevel}
          level={2}
          requestLabel={t("inbox.requested")}
          approveLabel={t("approvals.approve")}
          rejectLabel={t("approvals.reject")}
          onApprove={pending && s.canDecide ? () => decide("approve") : undefined}
          onReject={pending ? () => decide("reject") : undefined}
          data-testid="proposal-card"
        >
          <p class="inbox-status">
            <Badge variant={STATUS_VARIANT[s.status]} data-testid="detail-status"
              >{STATUS_LABEL[s.status]()}</Badge
            >
          </p>

          <div data-testid="detail-sponsor">
            <DescriptionList
              items={aboutItems(s)}
              columns={2}
              layout="stacked"
              ariaLabel={t("inbox.about")}
            />
          </div>

          <!-- Held uploads -->
          {#if (s.files?.length ?? 0) > 0}
            <div data-testid="proposal-files">
              <h3 class="inbox-h">{t("approvals.files")}</h3>
              <ul class="inbox-files">
                {#each s.files ?? [] as f (f.id)}
                  <li>
                    <div class="inbox-thumb">
                      {#if thumbnails[f.id] && thumbnails[f.id] !== "error"}
                        <img
                          src={thumbnails[f.id]}
                          alt={t("approvals.thumbnailAlt", { name: f.filename })}
                          data-testid="proposal-thumbnail"
                        />
                      {:else if thumbnails[f.id] === "error"}
                        <span class="inbox-danger">{t("approvals.fileLoadError")}</span>
                      {/if}
                    </div>
                    <p class="inbox-file-name" title={f.filename}>{f.filename}</p>
                    <p class="inbox-dim">{f.mimeType} · {size(f.size)}</p>
                  </li>
                {/each}
              </ul>
            </div>
          {:else if s.contentType?.startsWith("multipart/")}
            <p class="inbox-dim" data-testid="proposal-files-removed">
              {t("approvals.filesRemoved")}
            </p>
          {/if}

          {#if s.injectionCheck && /inject|unsafe|malicious|jailbreak/i.test(s.injectionCheck.label) && s.injectionCheck.score >= 0.5}
            <div data-testid="proposal-injection">
              <Alert variant="warning">
                {t("approvals.injectionWarning", {
                  label: s.injectionCheck.label,
                  score: s.injectionCheck.score.toFixed(2),
                })}
              </Alert>
            </div>
          {/if}

          {#if fieldDiffRedacted(s)}
            <p class="inbox-dim" data-testid="proposal-fields-redacted">
              {t("approvals.fieldsRedacted")}
            </p>
          {/if}

          <!-- The ledger: one row per field, accepted or not, with its evidence. -->
          {#if diff}
            {@const choosing = pending && s.canDecide}
            <div data-testid="proposal-fields">
              <h3 class="inbox-h">{t("approvals.fieldsTitle")}</h3>
              {#if diff.currentUnavailable !== undefined}
                <p class="inbox-warning">
                  {t("approvals.diffUnavailable", { v: String(diff.currentUnavailable) })}
                </p>
              {/if}
              {#if diff.fields.length === 0}
                <p class="inbox-dim">{t("approvals.noChanges")}</p>
              {:else}
                {#if choosing}<p class="inbox-dim">{t("approvals.fieldsHint")}</p>{/if}
                <Table density="compact">
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {choosing ? t("approvals.fieldAccept") : t("approvals.fieldDecision")}
                      </TableHead>
                      <TableHead>{t("approvals.field")}</TableHead>
                      <TableHead>{t("approvals.before")}</TableHead>
                      <TableHead>{t("approvals.after")}</TableHead>
                      <TableHead>{t("approvals.evidence")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {#each diff.fields as f (f.field)}
                      {@const decided = decisionOf(s, f.field)}
                      <TableRow>
                        <TableCell>
                          <span data-testid="field-row" data-field={f.field}>
                            {#if choosing && fieldChoice[f.field]}
                              <Checkbox
                                bind:checked={fieldChoice[f.field]!.accept}
                                ariaLabel={t("approvals.fieldAcceptAria", { field: f.field })}
                                data-testid="field-accept"
                              />
                            {:else if decided}
                              <Badge
                                variant={decided.decision === "accept" ? "success" : "default"}
                                size="sm"
                              >
                                {decided.decision === "accept"
                                  ? decided.edited
                                    ? t("approvals.fieldEdited")
                                    : t("approvals.fieldAccepted")
                                  : t("approvals.fieldRejected")}
                              </Badge>
                            {:else}
                              <span class="inbox-dim">—</span>
                            {/if}
                          </span>
                        </TableCell>
                        <TableCell>
                          <code>{f.field}</code>
                          {#if f.change === "remove"}
                            <Badge variant="error" size="sm">{t("approvals.fieldRemoved")}</Badge>
                          {:else if f.change === "add"}
                            <Badge variant="success" size="sm">{t("approvals.fieldAdded")}</Badge>
                          {/if}
                        </TableCell>
                        <TableCell><pre class="inbox-value">{json(f.before)}</pre></TableCell>
                        <TableCell>
                          <pre class="inbox-value">{json(f.after)}</pre>
                          {#if choosing && fieldChoice[f.field]?.accept}
                            <Input
                              bind:value={fieldChoice[f.field]!.value}
                              placeholder={t("approvals.fieldNewValue")}
                              aria-label={t("approvals.fieldNewValueAria", { field: f.field })}
                              data-testid="field-value"
                            />
                          {/if}
                        </TableCell>
                        <TableCell>
                          {#each evidenceOf(s, f.field) as e}
                            <div class="inbox-evidence" data-testid="field-evidence">
                              {#if isUrl(e.source)}
                                <a
                                  href={e.source}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow">{e.source}</a
                                >
                              {:else}
                                <code>{e.source}</code>
                              {/if}
                              {#if e.quote}<p class="inbox-quote">“{e.quote}”</p>{/if}
                              <p class="inbox-dim">
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
                            <span class="inbox-dim">{t("approvals.noEvidence")}</span>
                          {/each}
                        </TableCell>
                      </TableRow>
                    {/each}
                  </TableBody>
                </Table>
              {/if}
            </div>
          {/if}

          <!-- What the card's own DiffView could not say. -->
          <div data-testid="proposal-diff">
            {#if !s.diff}
              <p class="inbox-dim">{t("approvals.noDiff")}</p>
            {:else}
              {#if s.diff.currentUnavailable !== undefined}
                <p class="inbox-warning">
                  {t("approvals.diffUnavailable", { v: String(s.diff.currentUnavailable) })}
                </p>
              {/if}
              {#if s.diff.changes && s.diff.changes.length === 0}
                <p class="inbox-dim">{t("approvals.noChanges")}</p>
              {:else if s.diff.kind === "promotion"}
                <div class="inbox-promotion" data-testid="proposal-promotion">
                  <p>
                    {t("approvals.promotionSummary", {
                      action: s.diff.target?.slug ?? "—",
                      version: String(s.diff.versionNumber ?? "?"),
                      passed: String(s.diff.tests?.passed ?? 0),
                      total: String(s.diff.tests?.total ?? 0),
                      scan: s.diff.scan?.passed ? t("promotion.scanOk") : t("promotion.scanFail"),
                    })}
                  </p>
                  <ul>
                    {#each s.diff.decision?.reasons ?? [] as m}<li>
                        {t(`promotion.reason_${m}`)}
                      </li>{/each}
                  </ul>
                  <a href="/approvals?tab=promotion&version={s.diff.versionId}"
                    >{t("approvals.openPromotion")}</a
                  >
                </div>
              {/if}
            {/if}
          </div>

          <details class="inbox-body">
            <summary>{t("approvals.body")}</summary>
            <pre class="inbox-pre">{json(s.body) || "—"}</pre>
          </details>

          <!-- The decision's inputs (the buttons are the card's). -->
          {#if pending}
            {#if !s.canDecide}
              <!-- They cannot approve it (they could not do it themselves), but rejecting executes nothing. -->
              <p class="inbox-warning" data-testid="cannot-decide">
                {t("approvals.cannotDecide", {
                  reason: s.cannotDecideReason ? t(`approvals.why_${s.cannotDecideReason}`) : "",
                })}
              </p>
            {/if}
            <div class="inbox-decision">
              <Field label={t("approvals.comment")}>
                <Textarea
                  bind:value={comment}
                  rows={2}
                  placeholder={t("approvals.commentPlaceholder")}
                />
              </Field>
              {#if s.canDecide}
                <div class="inbox-pair">
                  <Field label={t("approvals.reviewAt")}>
                    <Input type="datetime-local" bind:value={reviewAt} data-testid="review-at" />
                  </Field>
                  <Field label={t("approvals.reviewNote")}>
                    <Input
                      bind:value={reviewNote}
                      placeholder={t("approvals.reviewNotePlaceholder")}
                    />
                  </Field>
                </div>
              {/if}
            </div>
          {:else}
            <div class="inbox-decided" data-testid="proposal-decision">
              {#if s.decidedBy}
                <p class="inbox-dim">
                  {t("approvals.decidedBy", {
                    name: s.decidedByName ?? s.decidedBy,
                    date: date(s.decidedAt),
                  })}
                </p>
              {/if}
              {#if s.comment}
                <p>{t("approvals.commentShown", { comment: s.comment })}</p>
              {/if}
              {#if s.result}
                <div>
                  <p class="inbox-dim">
                    {t("approvals.result")}
                    {#if s.result.status !== null}
                      <code data-testid="result-status">{s.result.status}</code>
                    {/if}
                  </p>
                  {#if s.result.error}
                    <p class="inbox-danger">
                      {t("approvals.resultError", { error: s.result.error })}
                    </p>
                  {/if}
                  <pre class="inbox-pre">{json(s.result.body) || "—"}</pre>
                </div>
              {/if}
              {#if s.status === "executed" || s.status === "failed" || s.status === "rejected"}
                <div class="inbox-reviews" data-testid="proposal-reviews">
                  <h3 class="inbox-h">{t("approvals.reviewsTitle")}</h3>
                  {#each s.reviews ?? [] as r (r.id)}
                    <p>
                      {t(`approvals.reviewStatus_${r.status}`)} · {date(r.dueAt)}{#if r.note}
                        · {r.note}{/if}
                    </p>
                  {:else}
                    <p class="inbox-dim">{t("approvals.noReviews")}</p>
                  {/each}
                  <div class="inbox-pair inbox-pair--end">
                    <Field label={t("approvals.reviewAt")}>
                      <Input type="datetime-local" bind:value={reviewAt} />
                    </Field>
                    <Field label={t("approvals.reviewNote")}>
                      <Input
                        bind:value={reviewNote}
                        placeholder={t("approvals.reviewNotePlaceholder")}
                      />
                    </Field>
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
        </ApprovalCard>
      {/key}
    {/if}
  </section>
</div>

<style>
  .inbox {
    display: grid;
    grid-template-columns: minmax(0, 26rem) minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
    min-width: 0;
  }
  .inbox-list,
  .inbox-detail {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .inbox-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
  }
  .inbox-count {
    margin-left: auto;
    padding-bottom: 0.375rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .inbox-keys {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .inbox-rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    overflow: hidden;
  }
  .inbox-row {
    display: flex;
    align-items: stretch;
    border-top: 1px solid rgb(var(--ta-border) / 0.7);
  }
  .inbox-row:first-child {
    border-top: none;
  }
  .inbox-row--current {
    background: rgb(var(--ta-accent) / 0.1);
  }
  .inbox-check {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 2.25rem;
  }
  .inbox-open {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.625rem 0.75rem 0.625rem 0;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }
  .inbox-open:hover {
    background: rgb(var(--ta-elevated) / 0.4);
  }
  .inbox-open:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: -2px;
  }
  .inbox-row-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .inbox-target {
    min-width: 0;
    overflow: hidden;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inbox-row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.75rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .inbox-status {
    margin: 0;
  }
  .inbox-h {
    margin: 0 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
  }
  .inbox-dim {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .inbox-warning {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-warning));
  }
  .inbox-danger {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-danger));
  }
  .inbox-files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.75rem;
  }
  .inbox-files li {
    width: 8rem;
  }
  .inbox-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 8rem;
    height: 8rem;
    overflow: hidden;
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
  }
  .inbox-thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .inbox-file-name {
    margin: 0.25rem 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inbox-value,
  .inbox-pre {
    margin: 0;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .inbox-pre {
    max-height: 14rem;
    margin-top: 0.375rem;
    padding: 0.5rem;
    overflow: auto;
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
  }
  .inbox-evidence {
    margin-bottom: 0.25rem;
    font-size: 0.75rem;
    word-break: break-all;
  }
  .inbox-evidence a,
  .inbox-promotion a {
    color: rgb(var(--ta-accent));
  }
  .inbox-quote {
    margin: 0;
    font-style: italic;
  }
  .inbox-promotion {
    font-size: 0.8125rem;
  }
  .inbox-promotion ul {
    margin: 0.25rem 0;
    padding-left: 1rem;
    color: rgb(var(--ta-text-dim));
  }
  .inbox-body summary {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    cursor: pointer;
  }
  .inbox-decision,
  .inbox-decided,
  .inbox-reviews {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.75rem;
    font-size: 0.8125rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
  .inbox-decided p,
  .inbox-reviews p {
    margin: 0;
  }
  .inbox-pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.5rem;
  }
  .inbox-pair--end {
    align-items: end;
  }
  @media (max-width: 900px) {
    .inbox {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
