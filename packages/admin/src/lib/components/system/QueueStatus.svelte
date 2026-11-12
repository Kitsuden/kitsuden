<!--
  The Postgres queue: counts per queue and state, and the
  «dead letter» with its last error, to retry or discard.
-->
<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { formatDateTime } from "$lib/utils";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";

  import { discardJob, queueStatus, retryJob, type QueueState } from "$lib/services/system";

  let status = $state<QueueState | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      status = await queueStatus();
    } catch (e) {
      error = e instanceof Error ? e.message : t("systemQueue.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function action(id: string, fn: (id: string) => Promise<unknown>) {
    try {
      busy = id;
      await fn(id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : t("systemQueue.errorLoading");
    } finally {
      busy = null;
    }
  }

  const date = formatDateTime;
  const STATUSES = ["pending", "running", "done", "dead"] as const;
  const statusLabel: Record<(typeof STATUSES)[number], () => string> = {
    pending: () => t("systemQueue.pending"),
    running: () => t("systemQueue.running"),
    done: () => t("systemQueue.done"),
    dead: () => t("systemQueue.dead"),
  };
  const workerTag = (w: QueueState["worker"]) =>
    w === "running"
      ? t("systemQueue.workerRunning")
      : w === "stopped"
        ? t("systemQueue.workerStopped")
        : t("systemQueue.workerDisabled");
</script>

<div class="space-y-4" data-testid="queue-status">
  <div class="flex flex-wrap items-center gap-3">
    <p class="text-xs text-kitsuden-subtle flex-1 min-w-0">{t("systemQueue.help")}</p>
    <Button variant="ghost" size="sm" onclick={load}>
      <RefreshCw size={14} aria-hidden="true" />{t("systemTraces.refresh")}
    </Button>
  </div>

  {#if loading && !status}
    <div class="flex items-center justify-center h-24">
      <Spinner />
    </div>
  {:else if error}
    <Alert variant="error">{error}</Alert>
  {:else if status}
    <div class="flex flex-wrap gap-2">
      <Badge
        size="md"
        dot
        variant={status.worker === "running"
          ? "success"
          : status.worker === "stopped"
            ? "warning"
            : "default"}>{t("systemQueue.worker")}: {workerTag(status.worker)}</Badge
      >
      <Badge size="md"
        >{t("systemQueue.listen")}: {status.listens
          ? t("systemQueue.yes")
          : t("systemQueue.no")}</Badge
      >
      {#each STATUSES as e}
        <Badge
          size="md"
          variant={e === "dead" && (status.totals.dead ?? 0) > 0 ? "error" : "default"}
          >{statusLabel[e]()}: {status.totals[e] ?? 0}</Badge
        >
      {/each}
    </div>

    {#if Object.keys(status.byQueue).length > 0}
      <div class="min-w-0">
        <Table density="compact">
          <TableHeader>
            <TableRow>
              <TableHead class="text-left">{t("systemQueue.colQueue")}</TableHead>
              {#each STATUSES as e}<TableHead class="text-right">{statusLabel[e]()}</TableHead
                >{/each}
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each Object.entries(status.byQueue) as [queue, account] (queue)}
              <TableRow>
                <TableCell class="font-mono">{queue}</TableCell>
                {#each STATUSES as e}<TableCell class="text-right">{account[e] ?? 0}</TableCell
                  >{/each}
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}

    <h3 class="text-sm font-medium text-kitsuden-text">{t("systemQueue.deadTitle")}</h3>
    {#if status.dead.length === 0}
      <EmptyState size="sm" icon={false} level={null} title={t("systemQueue.noDead")} />
    {:else}
      <div class="min-w-0">
        <Table density="compact">
          <TableHeader>
            <TableRow>
              <TableHead class="text-left">{t("systemQueue.colQueue")}</TableHead>
              <TableHead class="text-left">{t("systemQueue.colJob")}</TableHead>
              <TableHead class="text-right">{t("systemQueue.colAttempts")}</TableHead>
              <TableHead class="text-left">{t("systemQueue.colError")}</TableHead>
              <TableHead class="text-left">{t("systemQueue.colFinished")}</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each status.dead as j (j.id)}
              <TableRow data-testid="dead-job">
                <TableCell class="font-mono">{j.queue}</TableCell>
                <TableCell class="font-mono">{j.name}</TableCell>
                <TableCell class="text-right">{j.attempts}/{j.max_attempts}</TableCell>
                <TableCell class="max-w-md truncate" title={j.last_error ?? ""}
                  >{j.last_error ?? "—"}</TableCell
                >
                <TableCell class="whitespace-nowrap">{date(j.finished_at)}</TableCell>
                <TableCell class="whitespace-nowrap text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === j.id}
                    onclick={() => action(j.id, retryJob)}>{t("systemQueue.retry")}</Button
                  >
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={busy === j.id}
                    onclick={() => action(j.id, discardJob)}>{t("systemQueue.discard")}</Button
                  >
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  {/if}
</div>
