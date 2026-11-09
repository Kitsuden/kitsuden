<!--
  Code promotion for ONE agent: `suggestion` (the default: every
  draft is a proposal for a person) or `turbo` (activates by itself when
  all tests and checks pass and nothing widens permissions; needs the
  global cap). Only an admin changes it; it is audited.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { isAdmin } from "$lib/auth.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import { getPromotionSettings, setAgentPromotionMode } from "$lib/services/promotion";
  import type { PromotionMode } from "$lib/types/promotion";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  const MODES: PromotionMode[] = ["suggestion", "turbo"];
  let mode = $state<PromotionMode>("suggestion");
  let saved = $state<PromotionMode>("suggestion");
  let turboGlobal = $state(false);
  let canPropose = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      const a = await getPromotionSettings();
      turboGlobal = a.config.turboAllowed;
      const thisItem = a.agents.find((x) => x.id === agentId);
      mode = saved = thisItem?.mode ?? "suggestion";
      canPropose = thisItem?.canPropose ?? false;
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentPromotion.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function save() {
    try {
      saving = true;
      const r = await setAgentPromotionMode(agentId, mode);
      mode = saved = r.mode;
      toast.success(t("agentPromotion.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentPromotion.errorSaving"));
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4" data-testid="agent-promotion">
  <div>
    <h3 class="text-sm font-semibold text-zinc-300">{t("agentPromotion.title")}</h3>
    <p class="text-xs text-zinc-500">{t("agentPromotion.help")}</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else}
    {#if !canPropose}
      <p
        class="text-xs text-zinc-400 bg-zinc-800/40 border border-zinc-800 rounded px-3 py-2"
        data-testid="no-scope-note"
      >
        {t("agentPromotion.noScope")}
      </p>
    {/if}
    {#if mode === "turbo" && !turboGlobal}
      <p
        class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2"
        data-testid="turbo-capped-note"
      >
        {t("agentPromotion.turboCapped")}
      </p>
    {/if}
    <fieldset class="space-y-2" disabled={!isAdmin()}>
      <legend class="sr-only">{t("agentPromotion.title")}</legend>
      {#each MODES as m}
        <label
          class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer {mode === m
            ? 'border-indigo-500/60 bg-indigo-500/5'
            : 'border-zinc-800'}"
          data-testid="promotion-mode-{m}"
        >
          <input type="radio" name="promotion-mode" value={m} bind:group={mode} class="mt-1" />
          <span>
            <span class="block text-sm text-zinc-200">{t(`promotion.mode_${m}`)}</span>
            <span class="block text-xs text-zinc-500">{t(`agentPromotion.modeHelp_${m}`)}</span>
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
          <Save size={14} class="mr-1" />{t("agentPromotion.save")}
        </Button>
      {:else}
        <p class="text-xs text-amber-300/80">{t("approvals.readOnly")}</p>
      {/if}
      <a href="/approvals?tab=promotion" class="text-xs text-indigo-300 hover:underline"
        >{t("agentPromotion.pipelineLink")}</a
      >
    </div>
  {/if}
</div>
