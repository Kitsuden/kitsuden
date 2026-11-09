<!--
  The Postgres queue: counts per queue and state, and the
  «dead letter» with its last error, to retry or discard.
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";

  import Button from "$lib/components/ui/Button.svelte";
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

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
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
  <div class="flex items-center gap-3">
    <p class="text-xs text-zinc-500 flex-1">{t("systemQueue.help")}</p>
    <Button variant="ghost" size="sm" onclick={load}>
      <RefreshCw size={14} class="mr-1" />{t("systemTraces.refresh")}
    </Button>
  </div>

  {#if loading && !status}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if status}
    <div class="flex flex-wrap gap-3 text-xs">
      <span class="px-2 py-1 rounded-sm bg-zinc-900 border border-zinc-800 text-zinc-300"
        >{t("systemQueue.worker")}: {workerTag(status.worker)}</span
      >
      <span class="px-2 py-1 rounded-sm bg-zinc-900 border border-zinc-800 text-zinc-300"
        >{t("systemQueue.listen")}: {status.listens
          ? t("systemQueue.yes")
          : t("systemQueue.no")}</span
      >
      {#each STATUSES as e}
        <span
          class="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 {e === 'dead' &&
          (status.totals.dead ?? 0) > 0
            ? 'text-red-300'
            : 'text-zinc-300'}">{statusLabel[e]()}: {status.totals[e] ?? 0}</span
        >
      {/each}
    </div>

    {#if Object.keys(status.byQueue).length > 0}
      <div class="overflow-x-auto border border-zinc-800 rounded-lg">
        <table class="w-full text-xs">
          <thead class="text-zinc-500">
            <tr>
              <th class="text-left px-3 py-2">{t("systemQueue.colQueue")}</th>
              {#each STATUSES as e}<th class="text-right px-3 py-2">{statusLabel[e]()}</th>{/each}
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800/70">
            {#each Object.entries(status.byQueue) as [queue, account] (queue)}
              <tr>
                <td class="px-3 py-1.5 font-mono text-zinc-200">{queue}</td>
                {#each STATUSES as e}<td class="px-3 py-1.5 text-right text-zinc-400"
                    >{account[e] ?? 0}</td
                  >{/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <h3 class="text-sm font-medium text-zinc-200">{t("systemQueue.deadTitle")}</h3>
    {#if status.dead.length === 0}
      <p class="text-sm text-zinc-500">{t("systemQueue.noDead")}</p>
    {:else}
      <div class="overflow-x-auto border border-zinc-800 rounded-lg">
        <table class="w-full text-xs">
          <thead class="text-zinc-500">
            <tr>
              <th class="text-left px-3 py-2">{t("systemQueue.colQueue")}</th>
              <th class="text-left px-3 py-2">{t("systemQueue.colJob")}</th>
              <th class="text-right px-3 py-2">{t("systemQueue.colAttempts")}</th>
              <th class="text-left px-3 py-2">{t("systemQueue.colError")}</th>
              <th class="text-left px-3 py-2">{t("systemQueue.colFinished")}</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800/70">
            {#each status.dead as j (j.id)}
              <tr data-testid="dead-job">
                <td class="px-3 py-1.5 font-mono text-zinc-300">{j.queue}</td>
                <td class="px-3 py-1.5 font-mono text-zinc-300">{j.name}</td>
                <td class="px-3 py-1.5 text-right text-zinc-400">{j.attempts}/{j.max_attempts}</td>
                <td class="px-3 py-1.5 text-red-300 max-w-md truncate" title={j.last_error ?? ""}
                  >{j.last_error ?? "—"}</td
                >
                <td class="px-3 py-1.5 whitespace-nowrap text-zinc-400">{date(j.finished_at)}</td>
                <td class="px-3 py-1.5 whitespace-nowrap text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === j.id}
                    onclick={() => action(j.id, retryJob)}>{t("systemQueue.retry")}</Button
                  >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === j.id}
                    onclick={() => action(j.id, discardJob)}>{t("systemQueue.discard")}</Button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>
