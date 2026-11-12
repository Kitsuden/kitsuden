<!--
  Human approval audit: who turned each switch on or off and
  when, who proposed, who approved or rejected, and the outcome.
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
  import { t } from "$lib/i18n";
  import { formatDateTime } from "$lib/utils";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";
  import { listApprovalAudit } from "$lib/services/approvals";
  import type { ApprovalAuditEvent } from "$lib/types/approvals";

  let events = $state<ApprovalAuditEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      events = (await listApprovalAudit({ limit: 200 })).events;
    } catch (e) {
      error = e instanceof Error ? e.message : t("approvals.errorLoading");
    } finally {
      loading = false;
    }
  }

  // The panel's one way of writing a moment (see $lib/utils).
  const date = formatDateTime;

  /** A readable line of each action's details. */
  function summary(e: ApprovalAuditEvent): string {
    const d = e.details ?? {};
    switch (e.action) {
      case "approval_settings_changed": {
        const before = (d.before ?? {}) as Record<string, unknown>;
        const after = (d.after ?? {}) as Record<string, unknown>;
        const changes = Object.keys(after).filter(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
        );
        return changes
          .map((k) =>
            k === "enabled"
              ? t("approvals.auditGlobal", {
                  state: after.enabled ? t("approvals.globalOn") : t("approvals.globalOff"),
                })
              : t("approvals.auditChanged", { field: k })
          )
          .join(" · ");
      }
      case "approval_mode_changed":
        return t("approvals.auditMode", {
          before: t(`approvals.mode_${String(d.before)}`),
          after: t(`approvals.mode_${String(d.after)}`),
        });
      case "proposal_executed":
      case "proposal_failed":
        return [
          d.status != null ? t("approvals.auditStatus", { status: String(d.status) }) : "",
          d.error ? String(d.error) : "",
        ]
          .filter(Boolean)
          .join(" · ");
      case "proposal_approved":
      case "proposal_rejected":
        return d.comment ? t("approvals.commentShown", { comment: String(d.comment) }) : "";
      default:
        return "";
    }
  }

  const KIND: Record<string, string> = {
    approval_settings_changed: "text-kitsuden-accent",
    approval_mode_changed: "text-kitsuden-accent",
    proposal_created: "text-kitsuden-amber",
    proposal_approved: "text-kitsuden-green",
    proposal_executed: "text-kitsuden-green",
    proposal_rejected: "text-kitsuden-text",
    proposal_failed: "text-kitsuden-danger",
    proposal_expired: "text-kitsuden-subtle",
    promotion_submitted: "text-kitsuden-amber",
    promotion_activated: "text-kitsuden-green",
    promotion_watch_passed: "text-kitsuden-green",
    promotion_rejected: "text-kitsuden-text",
    promotion_rolled_back: "text-kitsuden-danger",
    promotion_manual_edit: "text-kitsuden-accent",
    promotion_activation_failed: "text-kitsuden-danger",
    promotion_activation_blocked: "text-kitsuden-amber",
    promotion_settings_changed: "text-kitsuden-accent",
    promotion_mode_changed: "text-kitsuden-accent",
  };
</script>

<div class="space-y-3" data-testid="approvals-audit">
  <div class="flex items-center gap-3">
    <p class="text-xs text-kitsuden-subtle flex-1">{t("approvals.auditHelp")}</p>
    <Button variant="ghost" size="sm" onclick={load}>
      <RefreshCw size={14} class="mr-1" />{t("approvals.refresh")}
    </Button>
  </div>
  {#if loading}
    <Skeleton lines={3} />
  {:else if error}
    <div
      class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
    >
      {error}
    </div>
  {:else if events.length === 0}
    <p class="text-sm text-kitsuden-subtle">{t("approvals.noEvents")}</p>
  {:else}
    <div class="overflow-x-auto border border-kitsuden-border rounded-lg">
      <Table class="w-full text-xs">
        <TableHeader class="text-kitsuden-subtle">
          <TableRow>
            <TableHead class="text-left px-3 py-2">{t("approvals.colWhen")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("approvals.colAction")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("approvals.colWho")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("approvals.colAgent")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("approvals.colDetails")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody class="divide-y divide-kitsuden-border/70">
          {#each events as e (e.id)}
            <TableRow data-testid="audit-row" data-action={e.action}>
              <TableCell class="px-3 py-1.5 whitespace-nowrap text-kitsuden-text-dim"
                >{date(e.at)}</TableCell
              >
              <TableCell
                class="px-3 py-1.5 whitespace-nowrap {KIND[e.action] ?? 'text-kitsuden-text'}"
                >{t(`approvals.action_${e.action}`)}</TableCell
              >
              <TableCell class="px-3 py-1.5 text-kitsuden-text">
                {e.byName ??
                  (e.action === "proposal_created" || e.action === "promotion_submitted"
                    ? (e.agentName ?? "—")
                    : t("approvals.system"))}
              </TableCell>
              <TableCell class="px-3 py-1.5 text-kitsuden-text-dim">{e.agentName ?? "—"}</TableCell>
              <TableCell class="px-3 py-1.5 text-kitsuden-text-dim min-w-0">
                {#if e.resource && e.action.startsWith("proposal_")}
                  <code class="text-kitsuden-text break-all">{e.resource}</code>
                {/if}
                <span class="ml-1">{summary(e)}</span>
                {#if e.proposalId && e.action.startsWith("proposal_")}
                  <a
                    href="/approvals?id={e.proposalId}"
                    class="ml-1 text-kitsuden-accent hover:underline">{t("approvals.open")}</a
                  >
                {:else if e.proposalId && e.action.startsWith("promotion_") && e.resource?.startsWith("action:")}
                  <code class="text-kitsuden-text break-all">{e.resource}</code>
                  <a
                    href="/approvals?tab=promotion&version={e.proposalId}"
                    class="ml-1 text-kitsuden-accent hover:underline">{t("approvals.open")}</a
                  >
                {/if}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
