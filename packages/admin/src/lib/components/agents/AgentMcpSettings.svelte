<!--
  An agent's MCP settings: default toolset (narrows tools/list; never grants
  anything) and how text written by others is wrapped in results.
  API: GET/PUT /api/v1/agents/:id/mcp-settings (lib/mcp-settings.ts).
-->
<script lang="ts">
  import { Button, Skeleton } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { Save } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";
  import { getAgentMcpSettings, setAgentMcpSettings } from "$lib/services/agents";
  import type { AgentMcpSettings, UntrustedWrap } from "$lib/types/agents";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  let settings = $state<AgentMcpSettings | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let toolset = $state("");
  let wrapper = $state<UntrustedWrap>("none");

  onMount(load);

  function fill(a: AgentMcpSettings) {
    settings = a;
    toolset = a.settings.toolset ?? "";
    wrapper = a.settings.untrustedWrap;
  }

  async function load() {
    try {
      loading = true;
      error = null;
      fill(await getAgentMcpSettings(agentId));
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentMcpSettings.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function save() {
    try {
      saving = true;
      fill(
        await setAgentMcpSettings(agentId, {
          toolset: toolset.trim() || null,
          untrustedWrap: wrapper,
        })
      );
      toast.success(t("agentMcpSettings.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentMcpSettings.errorSaving"));
    } finally {
      saving = false;
    }
  }

  const WRAPPER_TAG: Record<UntrustedWrap, () => string> = {
    none: () => t("agentMcpSettings.wrapNone"),
    delimiters: () => t("agentMcpSettings.wrapDelimiters"),
    object: () => t("agentMcpSettings.wrapObject"),
  };
</script>

<div class="space-y-4" data-testid="agent-mcp-settings">
  <div>
    <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentMcpSettings.title")}</h3>
    <p class="text-xs text-kitsuden-subtle">{t("agentMcpSettings.help")}</p>
  </div>

  {#if loading}
    <Skeleton lines={3} />
  {:else if error}
    <div
      class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
    >
      {error}
    </div>
  {:else if settings}
    <form
      class="grid grid-cols-1 md:grid-cols-2 gap-3 items-end"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div class="min-w-0">
        <label for="mcp-toolset" class="block text-sm text-kitsuden-text mb-1.5"
          >{t("agentMcpSettings.toolset")}</label
        >
        <input
          id="mcp-toolset"
          type="text"
          list="mcp-toolsets"
          bind:value={toolset}
          placeholder={t("agentMcpSettings.toolsetAll")}
          class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        />
        <datalist id="mcp-toolsets">
          {#each [...settings.options.toolsets, ...settings.options.kons] as option (option)}
            <option value={option}></option>
          {/each}
        </datalist>
        <p class="text-[11px] text-kitsuden-subtle mt-1">{t("agentMcpSettings.toolsetHelp")}</p>
      </div>
      <div class="min-w-0">
        <label for="mcp-wrap" class="block text-sm text-kitsuden-text mb-1.5"
          >{t("agentMcpSettings.wrap")}</label
        >
        <select
          id="mcp-wrap"
          bind:value={wrapper}
          class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        >
          {#each settings.options.untrustedWrap as mode (mode)}
            <option value={mode}>{WRAPPER_TAG[mode]?.() ?? mode}</option>
          {/each}
        </select>
        <p class="text-[11px] text-kitsuden-subtle mt-1">{t("agentMcpSettings.wrapHelp")}</p>
      </div>
      <div class="md:col-span-2 flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          <Save size={14} class="mr-1" />{t("agentMcpSettings.save")}
        </Button>
      </div>
    </form>
  {/if}
</div>
