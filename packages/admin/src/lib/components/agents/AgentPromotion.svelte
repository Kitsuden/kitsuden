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
    <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentPromotion.title")}</h3>
    <p class="text-xs text-kitsuden-subtle">{t("agentPromotion.help")}</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-kitsuden-accent"></div>
    </div>
  {:else if error}
    <div
      class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
    >
      {error}
    </div>
  {:else}
    {#if !canPropose}
      <p
        class="text-xs text-kitsuden-text-dim bg-kitsuden-border/40 border border-kitsuden-border rounded-sm px-3 py-2"
        data-testid="no-scope-note"
      >
        {t("agentPromotion.noScope")}
      </p>
    {/if}
    {#if mode === "turbo" && !turboGlobal}
      <p
        class="text-xs text-kitsuden-amber bg-kitsuden-amber/10 border border-kitsuden-amber/20 rounded-sm px-3 py-2"
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
            ? 'border-kitsuden-accent/60 bg-kitsuden-accent/5'
            : 'border-kitsuden-border'}"
          data-testid="promotion-mode-{m}"
        >
          <input type="radio" name="promotion-mode" value={m} bind:group={mode} class="mt-1" />
          <span>
            <span class="block text-sm text-kitsuden-text">{t(`promotion.mode_${m}`)}</span>
            <span class="block text-xs text-kitsuden-subtle"
              >{t(`agentPromotion.modeHelp_${m}`)}</span
            >
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
        <p class="text-xs text-kitsuden-amber">{t("approvals.readOnly")}</p>
      {/if}
      <a href="/approvals?tab=promotion" class="text-xs text-kitsuden-accent hover:underline"
        >{t("agentPromotion.pipelineLink")}</a
      >
    </div>
  {/if}
</div>
