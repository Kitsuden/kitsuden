<!--
  Code promotion: each agent code draft goes through
  sandbox tests, local scan, capability diff and decision
  (suggestion → proposal; turbo → self-activation if nothing widens permissions), and
  then through a monitored window with automatic rollback. Here you see the
  path of each version, approve or reject it, roll back, and adjust the
  turbo cap and the monitoring. Admin only (the API requires it).
  `?version=<id>` opens a version.
-->
<script lang="ts">
  import {
    Button,
    Skeleton,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import { Check, X, RefreshCw, RotateCcw, Play, Save, GitBranch } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";

  import { isAdmin } from "$lib/auth.svelte";
  import {
    activateCodeVersion,
    approveCodeVersion,
    getCodeVersion,
    getPromotionSettings,
    listCodeVersions,
    rejectCodeVersion,
    rollbackCodeVersion,
    savePromotionSettings,
    setAgentPromotionMode,
  } from "$lib/services/promotion";
  import type {
    CodeVersion,
    CodeVersionDetail,
    PromotionConfig,
    PromotionMode,
    PromotionSettings,
    VersionStatus,
  } from "$lib/types/promotion";

  interface Props {
    initialVersion?: string | null;
  }
  const { initialVersion = null }: Props = $props();

  const STATUSES: VersionStatus[] = [
    "awaiting_approval",
    "approved",
    "active",
    "superseded",
    "rolled_back",
    "rejected",
    "expired",
    "failed",
  ];
  const MODES: PromotionMode[] = ["suggestion", "turbo"];
  const KNOWN_ERRORS = ["code_actions_disabled", "stale_base"];

  let settings = $state<PromotionSettings | null>(null);
  let draftConfig = $state<PromotionConfig | null>(null);
  let savingConfig = $state(false);
  let filter = $state<VersionStatus | "">("");
  let versions = $state<CodeVersion[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let detail = $state<CodeVersionDetail | null>(null);
  let loadingDetail = $state(false);
  let comment = $state("");
  let returnReason = $state("");
  let busy = $state<string | null>(null);

  onMount(async () => {
    await Promise.all([loadSettings(), load()]);
    if (initialVersion) await open(initialVersion);
  });

  async function loadSettings() {
    try {
      settings = await getPromotionSettings();
      draftConfig = { ...settings.config };
    } catch (e) {
      error = e instanceof Error ? e.message : t("promotion.errorLoading");
    }
  }

  async function load() {
    try {
      loading = true;
      error = null;
      versions = (await listCodeVersions({ status: filter, limit: 200 })).versions;
    } catch (e) {
      error = e instanceof Error ? e.message : t("promotion.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function open(id: string) {
    try {
      loadingDetail = true;
      comment = "";
      returnReason = "";
      detail = await getCodeVersion(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("promotion.errorLoading"));
    } finally {
      loadingDetail = false;
    }
  }

  async function make(that: "approve" | "reject" | "rollback" | "activate") {
    if (!detail) return;
    const id = detail.version.id;
    try {
      busy = that;
      detail =
        that === "approve"
          ? await approveCodeVersion(id, comment.trim() || undefined)
          : that === "reject"
            ? await rejectCodeVersion(id, comment.trim() || undefined)
            : that === "rollback"
              ? await rollbackCodeVersion(id, returnReason.trim())
              : await activateCodeVersion(id);
      const status = t(`promotion.status_${detail.version.status}`);
      (detail.version.status === "failed" ? toast.error : toast.success)(
        t("promotion.done", { status: status })
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("promotion.errorDeciding"));
      await open(id);
    } finally {
      busy = null;
    }
  }

  async function saveConfig() {
    if (!draftConfig) return;
    try {
      savingConfig = true;
      settings = await savePromotionSettings({
        turboAllowed: draftConfig.turboAllowed,
        watchMinutes: Number(draftConfig.watchMinutes),
        minExecutions: Number(draftConfig.minExecutions),
        maxErrorRate: Number(draftConfig.maxErrorRate),
      });
      draftConfig = { ...settings.config };
      toast.success(t("promotion.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("promotion.errorSaving"));
    } finally {
      savingConfig = false;
    }
  }

  async function changeMode(agentId: string, mode: PromotionMode) {
    try {
      await setAgentPromotionMode(agentId, mode);
      toast.success(t("promotion.modeSaved"));
      await loadSettings();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("promotion.errorSaving"));
    }
  }

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
  const shortOne = (h: string | null) => (h ? h.slice(0, 12) : "—");
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  const COLOR: Record<VersionStatus, string> = {
    awaiting_approval: "bg-kitsuden-amber/15 text-kitsuden-amber",
    approved: "bg-kitsuden-info/15 text-kitsuden-info",
    active: "bg-kitsuden-green/15 text-kitsuden-green",
    superseded: "bg-kitsuden-muted/40 text-kitsuden-text-dim",
    rolled_back: "bg-kitsuden-danger/15 text-kitsuden-danger",
    rejected: "bg-kitsuden-muted/40 text-kitsuden-text",
    expired: "bg-kitsuden-muted/40 text-kitsuden-subtle",
    failed: "bg-kitsuden-danger/15 text-kitsuden-danger",
  };

  function stepClass(ok: boolean | null): string {
    return ok === null
      ? "border-kitsuden-border"
      : ok
        ? "border-kitsuden-green/30"
        : "border-kitsuden-danger/30";
  }
</script>

<div class="space-y-6" data-testid="code-promotion">
  <p class="text-xs text-kitsuden-subtle">{t("promotion.help")}</p>

  {#if settings && draftConfig}
    <section
      class="border border-kitsuden-border rounded-lg p-4 space-y-3"
      data-testid="promotion-settings"
    >
      <h3 class="text-sm font-semibold text-kitsuden-text">{t("promotion.settingsTitle")}</h3>
      {#if !settings.codeActionsEnabled}
        <p
          class="text-xs text-kitsuden-amber bg-kitsuden-amber/10 border border-kitsuden-amber/20 rounded-sm px-3 py-2"
          data-testid="code-actions-off"
        >
          {t("promotion.codeActionsOff")}
        </p>
      {/if}
      <p class="text-xs text-kitsuden-subtle">
        {t("promotion.approvalsMaster", {
          state: settings.approvalsEnabled ? t("approvals.globalOn") : t("approvals.globalOff"),
        })}
      </p>
      <fieldset class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" disabled={!isAdmin()}>
        <label class="flex items-start gap-2 text-sm text-kitsuden-text">
          <input
            type="checkbox"
            bind:checked={draftConfig.turboAllowed}
            class="mt-1"
            data-testid="turbo-allowed"
          />
          <span>
            <span class="block">{t("promotion.turboAllowed")}</span>
            <span class="block text-xs text-kitsuden-subtle">{t("promotion.turboAllowedHelp")}</span
            >
          </span>
        </label>
        <label class="text-xs text-kitsuden-text-dim">
          {t("promotion.watchMinutes")}
          <input
            type="number"
            min="1"
            max="1440"
            bind:value={draftConfig.watchMinutes}
            class="mt-1 w-full bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-sm text-kitsuden-text"
          />
        </label>
        <label class="text-xs text-kitsuden-text-dim">
          {t("promotion.minExecutions")}
          <input
            type="number"
            min="1"
            max="1000"
            bind:value={draftConfig.minExecutions}
            class="mt-1 w-full bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-sm text-kitsuden-text"
          />
        </label>
        <label class="text-xs text-kitsuden-text-dim">
          {t("promotion.maxErrorRate")}
          <input
            type="number"
            min="0.01"
            max="1"
            step="0.05"
            bind:value={draftConfig.maxErrorRate}
            class="mt-1 w-full bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-sm text-kitsuden-text"
          />
        </label>
      </fieldset>
      {#if isAdmin()}
        <Button variant="primary" size="sm" loading={savingConfig} onclick={saveConfig}>
          <Save size={14} class="mr-1" />{t("promotion.save")}
        </Button>
      {/if}

      <div
        class="overflow-x-auto border border-kitsuden-border rounded-sm"
        data-testid="promotion-agents"
      >
        <Table class="w-full text-xs">
          <TableHeader class="text-kitsuden-subtle">
            <TableRow>
              <TableHead class="text-left px-3 py-2">{t("promotion.colAgent")}</TableHead>
              <TableHead class="text-left px-3 py-2">{t("promotion.colCanPropose")}</TableHead>
              <TableHead class="text-left px-3 py-2">{t("promotion.colMode")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody class="divide-y divide-kitsuden-border/70">
            {#each settings.agents as a (a.id)}
              <TableRow>
                <TableCell class="px-3 py-1.5 text-kitsuden-text"
                  >{a.name}{a.isActive ? "" : ` (${t("promotion.inactive")})`}</TableCell
                >
                <TableCell class="px-3 py-1.5 text-kitsuden-text-dim"
                  >{a.canPropose ? t("promotion.yes") : t("promotion.no")}</TableCell
                >
                <TableCell class="px-3 py-1.5">
                  <select
                    class="bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-kitsuden-text"
                    value={a.mode}
                    disabled={!isAdmin()}
                    onchange={(e) =>
                      changeMode(
                        a.id,
                        (e.currentTarget as HTMLSelectElement).value as PromotionMode
                      )}
                    data-testid="promotion-mode-{a.id}"
                  >
                    {#each MODES as m}
                      <option value={m}>{t(`promotion.mode_${m}`)}</option>
                    {/each}
                  </select>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    </section>
  {/if}

  <div class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <section class="space-y-3 min-w-0">
      <div class="flex items-center gap-2">
        <select
          class="bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-xs text-kitsuden-text"
          bind:value={filter}
          onchange={load}
          data-testid="promotion-filter"
        >
          <option value="">{t("promotion.allStatuses")}</option>
          {#each STATUSES as e}
            <option value={e}>{t(`promotion.status_${e}`)}</option>
          {/each}
        </select>
        <div class="flex-1"></div>
        <Button variant="ghost" size="sm" onclick={load}
          ><RefreshCw size={14} class="mr-1" />{t("promotion.refresh")}</Button
        >
      </div>
      {#if loading}
        <Skeleton lines={3} />
      {:else if error}
        <div
          class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
        >
          {error}
        </div>
      {:else if versions.length === 0}
        <p class="text-sm text-kitsuden-subtle">{t("promotion.empty")}</p>
      {:else}
        <ul class="space-y-1" data-testid="promotion-list">
          {#each versions as v (v.id)}
            <li>
              <button
                class="w-full text-left px-3 py-2 rounded border min-w-0 {detail?.version.id ===
                v.id
                  ? 'border-kitsuden-accent/60 bg-kitsuden-accent/5'
                  : 'border-kitsuden-border hover:border-kitsuden-muted'}"
                onclick={() => open(v.id)}
                data-testid="promotion-row"
                data-status={v.status}
              >
                <div class="flex items-center gap-2 min-w-0">
                  <GitBranch size={14} class="text-kitsuden-subtle shrink-0" />
                  <span class="text-sm text-kitsuden-text truncate min-w-0"
                    >{v.target.slug} · v{v.versionNumber}</span
                  >
                  {#if v.origin !== "agent"}<span class="text-xs text-kitsuden-subtle shrink-0"
                      >{t(`promotion.origin_${v.origin}`)}</span
                    >{/if}
                  <span
                    class="ml-auto text-xs px-1.5 py-0.5 rounded-full shrink-0 {COLOR[v.status]}"
                    >{t(`promotion.status_${v.status}`)}</span
                  >
                </div>
                <div class="text-[11px] text-kitsuden-subtle mt-0.5 truncate">
                  {v.agentName ?? v.agentId ?? "—"} · {t(`promotion.mode_${v.mode}`)} ·
                  {t("promotion.testsShort", {
                    passed: String(v.testReport?.passed ?? 0),
                    total: String(v.testReport?.total ?? 0),
                  })} ·
                  {v.scanReport?.passed ? t("promotion.scanOk") : t("promotion.scanFail")} · {date(
                    v.createdAt
                  )}
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="min-w-0" data-testid="promotion-detail">
      {#if loadingDetail}
        <Skeleton lines={3} />
      {:else if !detail}
        <p class="text-sm text-kitsuden-subtle">{t("promotion.pick")}</p>
      {:else}
        {@const v = detail.version}
        <div class="space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-base font-semibold text-kitsuden-text min-w-0 truncate">
              {v.target.name} · v{v.versionNumber}
            </h3>
            <span
              class="text-xs px-1.5 py-0.5 rounded-full {COLOR[v.status]}"
              data-testid="detail-status">{t(`promotion.status_${v.status}`)}</span
            >
          </div>
          <p class="text-xs text-kitsuden-subtle">
            {t("promotion.byAgent", {
              agent: v.agentName ?? v.agentId ?? "—",
              signer: v.sponsorName ?? v.sponsorUserId ?? "—",
            })} ·
            {t("promotion.hashes", {
              content: shortOne(v.contentHash),
              base: shortOne(v.baseHash),
            })}
          </p>
          {#if v.description}<p class="text-sm text-kitsuden-text">{v.description}</p>{/if}

          <!-- 1. Tests -->
          <div
            class="border rounded p-3 {stepClass(
              v.testReport
                ? v.testReport.failed + v.testReport.errored === 0 && v.testReport.total > 0
                : null
            )}"
            data-testid="step-tests"
          >
            <h4 class="text-xs font-semibold text-kitsuden-text">
              {t("promotion.stepTests")} — {t("promotion.testsSummary", {
                passed: String(v.testReport?.passed ?? 0),
                failed: String(v.testReport?.failed ?? 0),
                errored: String(v.testReport?.errored ?? 0),
                total: String(v.testReport?.total ?? 0),
              })}
            </h4>
            {#if v.testReport?.cases?.length}
              <ul class="mt-1 space-y-1">
                {#each v.testReport.cases as c}
                  <li class="text-xs">
                    <span
                      class={c.status === "passed" ? "text-kitsuden-green" : "text-kitsuden-danger"}
                      >{t(`promotion.test_${c.status}`)}</span
                    >
                    <span class="text-kitsuden-text ml-1">{c.name}</span>
                    <span class="text-kitsuden-subtle ml-1"
                      >{t("promotion.ms", { ms: String(c.durationMs) })}</span
                    >
                    {#each c.mismatches as m}<div class="text-kitsuden-text-dim ml-4 break-all">
                        {m}
                      </div>{/each}
                    {#if c.error && c.status !== "passed"}<div
                        class="text-kitsuden-subtle ml-4 break-all"
                      >
                        {c.error}
                      </div>{/if}
                    {#if c.unmockedCalls.length}<div class="text-kitsuden-amber ml-4 break-all">
                        {t("promotion.unmocked", { calls: c.unmockedCalls.join(", ") })}
                      </div>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- 2. Scan -->
          <div
            class="border rounded-sm p-3 {stepClass(v.scanReport ? v.scanReport.passed : null)}"
            data-testid="step-scan"
          >
            <h4 class="text-xs font-semibold text-kitsuden-text">
              {t("promotion.stepScan")} — {v.scanReport?.passed
                ? t("promotion.scanOk")
                : t("promotion.scanFail")}
            </h4>
            {#each v.scanReport?.findings ?? [] as h}
              <div class="text-xs mt-1">
                <span
                  class={h.severity === "high"
                    ? "text-kitsuden-danger"
                    : h.severity === "medium"
                      ? "text-kitsuden-amber"
                      : "text-kitsuden-text-dim"}>{h.severity}</span
                >
                <code class="text-kitsuden-text ml-1">{h.rule}</code>
                <span class="text-kitsuden-subtle ml-1">L{h.line}: {h.message}</span>
              </div>
            {/each}
            {#if v.scanReport?.apiCalls?.length}
              <div class="text-xs text-kitsuden-subtle mt-1 break-all">
                {t("promotion.apiCalls")}: {v.scanReport.apiCalls
                  .map((c) => `${c.method} ${c.path ?? "?"}`)
                  .join(", ")}
              </div>
            {/if}
          </div>

          <!-- 3. Capabilities -->
          <div class="border rounded-sm p-3 border-kitsuden-border" data-testid="step-capabilities">
            <h4 class="text-xs font-semibold text-kitsuden-text">
              {t("promotion.stepCapabilities")}
            </h4>
            <div class="text-xs text-kitsuden-text-dim mt-1 space-y-0.5 break-all">
              <div>
                {t("promotion.declaredScopes")}:
                <code>{v.capabilities.scopes.join(", ") || "—"}</code>
              </div>
              <div>
                {t("promotion.declaredHosts")}:
                <code>{v.capabilities.fetchAllow.join(", ") || "—"}</code>
              </div>
              {#if v.capabilityDiff}
                {#if v.capabilityDiff.newTarget}<div class="text-kitsuden-amber">
                    {t("promotion.newTarget")}
                  </div>{/if}
                {#if v.capabilityDiff.scopesAdded.length}<div class="text-kitsuden-danger">
                    + {v.capabilityDiff.scopesAdded.join(", ")}
                  </div>{/if}
                {#if v.capabilityDiff.denialsRemoved.length}<div class="text-kitsuden-danger">
                    − {v.capabilityDiff.denialsRemoved.join(", ")}
                  </div>{/if}
                {#if v.capabilityDiff.hostsAdded.length}<div class="text-kitsuden-danger">
                    + {v.capabilityDiff.hostsAdded.join(", ")}
                  </div>{/if}
                {#each v.capabilityDiff.limitsIncreased as l}<div class="text-kitsuden-amber">
                    {l.field}: {l.before} → {l.after}
                  </div>{/each}
              {/if}
            </div>
          </div>

          <!-- 4. Decision -->
          <div class="border rounded-sm p-3 border-kitsuden-border" data-testid="step-decision">
            <h4 class="text-xs font-semibold text-kitsuden-text">
              {t("promotion.stepDecision")} — {v.decision?.route === "turbo"
                ? t("promotion.routeTurbo")
                : t("promotion.routeProposal")}
            </h4>
            <ul class="mt-1 text-xs text-kitsuden-text-dim list-disc ml-4">
              {#each v.decision?.reasons ?? [] as m}<li data-testid="reason" data-reason={m}>
                  {t(`promotion.reason_${m}`)}
                </li>{/each}
            </ul>
            {#if detail.proposal}
              <p class="text-xs text-kitsuden-subtle mt-1">
                {t("promotion.proposal", {
                  status: t(`approvals.status_${detail.proposal.status}`),
                })}
                <a
                  href="/approvals?id={detail.proposal.id}"
                  class="ml-1 text-kitsuden-accent hover:underline">{t("approvals.open")}</a
                >
                {#if detail.proposal.comment}· {t("approvals.commentShown", {
                    comment: detail.proposal.comment,
                  })}{/if}
              </p>
            {/if}
            {#if v.activationError}
              <p class="text-xs text-kitsuden-danger mt-1" data-testid="activation-error">
                {KNOWN_ERRORS.includes(v.activationError)
                  ? t(`promotion.activationError_${v.activationError}`)
                  : t("promotion.activationErrorOther", { error: v.activationError })}
              </p>
            {/if}
          </div>

          <!-- 5. Activation and monitoring -->
          {#if v.activatedAt || v.rolledBackAt}
            <div class="border rounded-sm p-3 border-kitsuden-border" data-testid="step-watch">
              <h4 class="text-xs font-semibold text-kitsuden-text">{t("promotion.stepWatch")}</h4>
              <div class="text-xs text-kitsuden-text-dim mt-1 space-y-0.5">
                {#if v.activatedAt}<div>
                    {t("promotion.activated", {
                      when: date(v.activatedAt),
                      by: v.activatedByName ?? v.activatedBy ?? "—",
                    })}
                  </div>{/if}
                {#if v.watch}
                  <div>
                    {t("promotion.watchState", {
                      state: t(`promotion.watch_${v.watch.state ?? "watching"}`),
                      executions: String(v.watch.executions ?? 0),
                      errors: String(v.watch.errors ?? 0),
                      until: date(v.watchUntil),
                    })}
                  </div>
                {/if}
                {#if v.rolledBackAt}
                  <div class="text-kitsuden-danger">
                    {t("promotion.rolledBack", {
                      when: date(v.rolledBackAt),
                      by: v.rolledBackByName ?? v.rolledBackBy ?? "—",
                    })}
                  </div>
                  <div class="text-kitsuden-subtle break-all">{v.rollbackReason}</div>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Actions -->
          {#if isAdmin()}
            {#if v.status === "awaiting_approval"}
              <div class="space-y-2" data-testid="promotion-decide">
                <textarea
                  bind:value={comment}
                  rows="2"
                  placeholder={t("promotion.commentPlaceholder")}
                  class="w-full bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-sm text-kitsuden-text"
                ></textarea>
                <div class="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === "approve"}
                    onclick={() => make("approve")}
                    ><Check size={14} class="mr-1" />{t("promotion.approve")}</Button
                  >
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === "reject"}
                    onclick={() => make("reject")}
                    ><X size={14} class="mr-1" />{t("promotion.reject")}</Button
                  >
                </div>
              </div>
            {:else if v.status === "active" && v.origin !== "baseline"}
              <div class="space-y-2" data-testid="promotion-rollback">
                <input
                  bind:value={returnReason}
                  placeholder={t("promotion.rollbackReason")}
                  class="w-full bg-kitsuden-card border border-kitsuden-input rounded-sm px-2 py-1 text-sm text-kitsuden-text"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!returnReason.trim()}
                  loading={busy === "rollback"}
                  onclick={() => make("rollback")}
                >
                  <RotateCcw size={14} class="mr-1" />{t("promotion.rollback")}
                </Button>
              </div>
            {:else if v.status === "approved"}
              <Button
                variant="primary"
                size="sm"
                loading={busy === "activate"}
                onclick={() => make("activate")}
                ><Play size={14} class="mr-1" />{t("promotion.activate")}</Button
              >
            {/if}
          {/if}

          <details open>
            <summary class="text-xs text-kitsuden-text-dim cursor-pointer"
              >{t("promotion.code")}</summary
            >
            <pre
              class="text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-kitsuden-text"
              data-testid="promotion-code">{v.code}</pre>
          </details>
          {#if detail.previous}
            <details>
              <summary class="text-xs text-kitsuden-text-dim cursor-pointer"
                >{t("promotion.previousCode", {
                  n: String(detail.previous.versionNumber),
                })}</summary
              >
              <pre
                class="text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-kitsuden-text-dim">{detail
                  .previous.code}</pre>
            </details>
          {/if}
          <details>
            <summary class="text-xs text-kitsuden-text-dim cursor-pointer"
              >{t("promotion.testCases")}</summary
            >
            <pre
              class="text-xs bg-kitsuden-bg border border-kitsuden-border rounded-sm p-2 max-h-60 overflow-auto whitespace-pre-wrap break-all">{json(
                v.tests
              )}</pre>
          </details>
          <details>
            <summary class="text-xs text-kitsuden-text-dim cursor-pointer"
              >{t("promotion.timeline")}</summary
            >
            <ul class="mt-1 space-y-0.5" data-testid="promotion-events">
              {#each detail.events as e (e.id)}
                <li class="text-xs text-kitsuden-text-dim">
                  <span class="text-kitsuden-subtle">{date(e.at)}</span>
                  <span class="ml-1 text-kitsuden-text">{t(`approvals.action_${e.action}`)}</span>
                  {#if e.byName}<span class="ml-1">· {e.byName}</span>{/if}
                </li>
              {/each}
            </ul>
          </details>
        </div>
      {/if}
    </section>
  </div>
</div>
