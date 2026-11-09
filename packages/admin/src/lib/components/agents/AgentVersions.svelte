<!--
  The history of an agent's definition (system prompt, tools, capabilities):
  one row per distinct version, newest first. Each run records the version
  that acted. Restoring writes an old version back as a new one (admin only).
  API: /api/v1/agents/:id/versions (apps/api/src/lib/agent-versions.ts).
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { History, RotateCcw } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { isAdmin } from "$lib/auth.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import {
    getAgentVersion,
    listAgentVersions,
    restoreAgentVersion,
    type AgentVersionDetail,
    type AgentVersionSummary,
  } from "$lib/services/agents";

  interface Props {
    agentId: string;
    /** After a restore, so the page reloads the agent's fields. */
    onRestored?: () => void;
  }
  const { agentId, onRestored }: Props = $props();

  let versions = $state<AgentVersionSummary[]>([]);
  let current = $state<number | null>(null);
  let open = $state<Record<number, AgentVersionDetail | undefined>>({});
  let loading = $state(true);
  let restoring = $state<number | null>(null);
  let error = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      const r = await listAgentVersions(agentId);
      versions = r.versions;
      current = r.current;
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentVersions.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function toggle(v: number) {
    if (open[v]) {
      open = { ...open, [v]: undefined };
      return;
    }
    try {
      open = { ...open, [v]: await getAgentVersion(agentId, v) };
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentVersions.errorLoading"));
    }
  }

  async function restore(v: number) {
    try {
      restoring = v;
      await restoreAgentVersion(agentId, v);
      toast.success(t("agentVersions.restored", { n: v }));
      open = {};
      await load();
      onRestored?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentVersions.errorRestoring"));
    } finally {
      restoring = null;
    }
  }

  const date = (v: string) => new Date(v).toLocaleString(localeFormat());
</script>

<div class="space-y-4" data-testid="agent-versions">
  <div>
    <h3 class="text-sm font-semibold text-zinc-300">
      <History size={14} class="inline mr-1" />{t("agentVersions.title")}
    </h3>
    <p class="text-xs text-zinc-500">{t("agentVersions.help")}</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if versions.length === 0}
    <p class="text-sm text-zinc-500">{t("agentVersions.empty")}</p>
  {:else}
    <ol class="space-y-2">
      {#each versions as v (v.id)}
        {@const detail = open[v.version]}
        <li class="p-3 rounded-lg border border-zinc-800" data-testid="version-{v.version}">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-zinc-200 font-medium"
              >{t("agentVersions.version", { n: v.version })}</span
            >
            {#if v.version === current}
              <span
                class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300"
                >{t("agentVersions.current")}</span
              >
            {/if}
            <span class="text-xs text-zinc-500">{t(`agentVersions.source_${v.source}`)}</span>
            {#if v.note}<span class="text-xs text-zinc-500">· {v.note}</span>{/if}
            <span class="text-xs text-zinc-500">· {date(v.createdAt)}</span>
            {#if v.createdBy}<span class="text-xs text-zinc-500"
                >· {t("agentVersions.by", { who: v.createdBy })}</span
              >{/if}
            <div class="flex-1"></div>
            <Button variant="ghost" size="sm" onclick={() => toggle(v.version)}>
              {detail ? t("agentVersions.hide") : t("agentVersions.show")}
            </Button>
            {#if isAdmin() && v.version !== current}
              <Button
                variant="secondary"
                size="sm"
                loading={restoring === v.version}
                onclick={() => restore(v.version)}
              >
                <RotateCcw size={14} class="mr-1" />{t("agentVersions.restore")}
              </Button>
            {/if}
          </div>
          <p class="text-xs text-zinc-500 mt-1">
            {t("agentVersions.promptChars", { n: v.promptLength })} ·
            {v.config.allowedTools?.length
              ? t("agentVersions.tools", { list: v.config.allowedTools.join(", ") })
              : t("agentVersions.noTools")}
            · <code class="text-zinc-600">{v.hash.slice(0, 12)}</code>
          </p>
          {#if detail}
            <pre
              class="mt-2 p-2 bg-zinc-950 border border-zinc-800 rounded-sm text-xs text-zinc-300 whitespace-pre-wrap">{detail.systemPrompt ??
                t("agentVersions.noPrompt")}</pre>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>
