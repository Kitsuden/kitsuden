<!--
  An agent's MCP settings: default toolset (narrows tools/list; never grants
  anything) and how text written by others is wrapped in results.
  API: GET/PUT /api/v1/agents/:id/mcp-settings (lib/mcp-settings.ts).
-->
<script lang="ts">
  import {
    Alert,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Field,
    Input,
    SaveBar,
    Select,
    Skeleton,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
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

  /** The form differs from the saved settings. */
  const dirty = $derived(
    !!settings &&
      ((toolset.trim() || null) !== (settings.settings.toolset ?? null) ||
        wrapper !== settings.settings.untrustedWrap)
  );

  function discard() {
    if (settings) fill(settings);
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

<div data-testid="agent-mcp-settings">
  <Card>
    <CardHeader>
      <CardTitle level={2}>{t("agentMcpSettings.title")}</CardTitle>
      <p class="text-xs text-kitsuden-subtle">{t("agentMcpSettings.help")}</p>
    </CardHeader>
    <CardContent>
      {#if loading}
        <Skeleton lines={3} />
      {:else if error}
        <Alert variant="error">{error}</Alert>
      {:else if settings}
        <form
          id="agent-mcp-form"
          onsubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            <div class="min-w-0">
              <Field label={t("agentMcpSettings.toolset")}>
                <Input
                  id="mcp-toolset"
                  list="mcp-toolsets"
                  bind:value={toolset}
                  placeholder={t("agentMcpSettings.toolsetAll")}
                />
              </Field>
              <datalist id="mcp-toolsets">
                {#each [...settings.options.toolsets, ...settings.options.kons] as option (option)}
                  <option value={option}></option>
                {/each}
              </datalist>
              <p class="text-[11px] text-kitsuden-subtle mt-1">
                {t("agentMcpSettings.toolsetHelp")}
              </p>
            </div>
            <div class="min-w-0">
              <Field label={t("agentMcpSettings.wrap")}>
                <Select
                  id="mcp-wrap"
                  value={wrapper}
                  onchange={(e: Event) =>
                    (wrapper = (e.currentTarget as HTMLSelectElement).value as UntrustedWrap)}
                  options={settings.options.untrustedWrap.map((mode) => ({
                    value: mode,
                    label: WRAPPER_TAG[mode]?.() ?? mode,
                  }))}
                />
              </Field>
              <p class="text-[11px] text-kitsuden-subtle mt-1">{t("agentMcpSettings.wrapHelp")}</p>
            </div>
          </div>
          <SaveBar
            form="agent-mcp-form"
            sticky={false}
            {dirty}
            {saving}
            disableWhenClean
            saveLabel={t("agentMcpSettings.save")}
            cancelLabel={t("record.discard")}
            onCancel={dirty ? discard : undefined}
          />
        </form>
      {/if}
    </CardContent>
  </Card>
</div>
