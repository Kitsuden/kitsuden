<!--
  Human approval of ONE agent: inherit (only what is sensitive), «propose
  only» (also what writes) or direct (never asks for approval). With the master
  switch off, no mode holds anything back, and a warning is shown. Only an
  admin changes it; it is audited.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { isAdmin } from "$lib/auth.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import {
    getApprovalSettings,
    setAgentApprovalMode,
    setAgentUnattended,
  } from "$lib/services/approvals";
  import type { ApprovalMode, UnattendedMode } from "$lib/types/approvals";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  const MODES: ApprovalMode[] = ["inherit", "propose", "direct"];
  let mode = $state<ApprovalMode>("inherit");
  let saved = $state<ApprovalMode>("inherit");
  let globalActive = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Unattended runs (cron/event, Kitsuden-Unattended): "" = the global setting.
  type Unattended = "" | UnattendedMode;
  let unattended = $state<Unattended>("");
  let savedUnattended = $state<Unattended>("");
  let alternative = $state("");
  let savedAlternative = $state("");
  let globalUnattended = $state<UnattendedMode>("hold");
  let savingUnattended = $state(false);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      const a = await getApprovalSettings();
      globalActive = a.config.enabled;
      const thisItem = a.agents.find((x) => x.id === agentId);
      mode = saved = thisItem?.mode ?? "inherit";
      globalUnattended = a.config.unattended ?? "hold";
      unattended = savedUnattended = thisItem?.unattended ?? "";
      alternative = savedAlternative = thisItem?.unattendedAlternative ?? "";
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentApproval.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function saveUnattended() {
    try {
      savingUnattended = true;
      const r = await setAgentUnattended(agentId, {
        mode: unattended === "" ? null : unattended,
        alternative: alternative.trim() === "" ? null : alternative.trim(),
      });
      unattended = savedUnattended = r.mode ?? "";
      alternative = savedAlternative = r.alternative ?? "";
      toast.success(t("agentApproval.unattendedSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentApproval.errorSaving"));
    } finally {
      savingUnattended = false;
    }
  }

  async function save() {
    try {
      saving = true;
      const r = await setAgentApprovalMode(agentId, mode);
      mode = saved = r.mode;
      toast.success(t("agentApproval.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentApproval.errorSaving"));
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4" data-testid="agent-approval">
  <div>
    <h3 class="text-sm font-semibold text-zinc-300">{t("agentApproval.title")}</h3>
    <p class="text-xs text-zinc-500">
      {t("agentApproval.help", {
        state: globalActive ? t("agentApproval.globalOn") : t("agentApproval.globalOff"),
      })}
    </p>
  </div>

  {#if !loading && !error && !globalActive && mode !== "direct"}
    <p
      class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-sm px-3 py-2"
      data-testid="global-off-note"
    >
      {t("agentApproval.globalOffNote")}
    </p>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else}
    <fieldset class="space-y-2" disabled={!isAdmin()}>
      <legend class="sr-only">{t("agentApproval.title")}</legend>
      {#each MODES as m}
        <label
          class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer {mode === m
            ? 'border-indigo-500/60 bg-indigo-500/5'
            : 'border-zinc-800'}"
          data-testid="mode-{m}"
        >
          <input type="radio" name="approval-mode" value={m} bind:group={mode} class="mt-1" />
          <span>
            <span class="block text-sm text-zinc-200">{t(`approvals.mode_${m}`)}</span>
            <span class="block text-xs text-zinc-500">{t(`agentApproval.modeHelp_${m}`)}</span>
          </span>
        </label>
      {/each}
    </fieldset>
    <div class="flex flex-wrap items-center gap-3">
      {#if isAdmin()}
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={mode === saved}
          onclick={save}
        >
          <Save size={14} class="mr-1" />{t("agentApproval.save")}
        </Button>
      {:else}
        <p class="text-xs text-amber-300/80">{t("approvals.readOnly")}</p>
      {/if}
      <a href="/approvals" class="text-xs text-indigo-300 hover:underline"
        >{t("agentApproval.inboxLink")}</a
      >
    </div>

    <div class="pt-4 border-t border-zinc-800 space-y-3" data-testid="agent-unattended">
      <div>
        <h4 class="text-sm font-semibold text-zinc-300">{t("agentApproval.unattendedTitle")}</h4>
        <p class="text-xs text-zinc-500">{t("agentApproval.unattendedHelp")}</p>
      </div>
      <fieldset class="space-y-1" disabled={!isAdmin()}>
        <legend class="sr-only">{t("agentApproval.unattendedTitle")}</legend>
        <label class="flex items-center gap-2 text-sm text-zinc-200">
          <input type="radio" name="unattended" value="" bind:group={unattended} />
          {t("agentApproval.unattended_global", {
            mode: t(`agentApproval.unattended_${globalUnattended}`),
          })}
        </label>
        <label class="flex items-center gap-2 text-sm text-zinc-200">
          <input type="radio" name="unattended" value="hold" bind:group={unattended} />
          {t("agentApproval.unattended_hold")}
        </label>
        <label class="flex items-center gap-2 text-sm text-zinc-200">
          <input type="radio" name="unattended" value="deny" bind:group={unattended} />
          {t("agentApproval.unattended_deny")}
        </label>
      </fieldset>
      <label class="block">
        <span class="block text-xs text-zinc-400 mb-1">{t("agentApproval.alternativeLabel")}</span>
        <textarea
          bind:value={alternative}
          rows={2}
          maxlength={1000}
          disabled={!isAdmin()}
          placeholder={t("agentApproval.alternativePlaceholder")}
          class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 resize-none"
        ></textarea>
      </label>
      {#if isAdmin()}
        <Button
          variant="primary"
          size="sm"
          loading={savingUnattended}
          disabled={unattended === savedUnattended && alternative === savedAlternative}
          onclick={saveUnattended}
        >
          <Save size={14} class="mr-1" />{t("agentApproval.saveUnattended")}
        </Button>
      {/if}
    </div>
  {/if}
</div>
