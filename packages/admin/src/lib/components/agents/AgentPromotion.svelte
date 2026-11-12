<!--
  Code promotion for ONE agent: `suggestion` (the default: every
  draft is a proposal for a person) or `turbo` (activates by itself when
  all tests and checks pass and nothing widens permissions; needs the
  global cap). Only an admin changes it; it is audited.
-->
<script lang="ts">
  import {
    Alert,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    RadioGroup,
    SaveBar,
    Skeleton,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";

  import { isAdmin } from "$lib/auth.svelte";
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

<div data-testid="agent-promotion">
  <Card>
    <CardHeader>
      <CardTitle level={2}>{t("agentPromotion.title")}</CardTitle>
      <p class="text-xs text-kitsuden-subtle">{t("agentPromotion.help")}</p>
    </CardHeader>
    <CardContent class="space-y-4">
      {#if loading}
        <Skeleton lines={3} />
      {:else if error}
        <Alert variant="error">{error}</Alert>
      {:else}
        {#if !canPropose}
          <div data-testid="no-scope-note">
            <Alert variant="info">{t("agentPromotion.noScope")}</Alert>
          </div>
        {/if}
        {#if mode === "turbo" && !turboGlobal}
          <div data-testid="turbo-capped-note">
            <Alert variant="warning">{t("agentPromotion.turboCapped")}</Alert>
          </div>
        {/if}
        <RadioGroup
          legend={t("agentPromotion.title")}
          hideLegend
          name="promotion-mode"
          disabled={!isAdmin()}
          value={mode}
          onchange={(v) => (mode = v as PromotionMode)}
          options={MODES.map((m) => ({
            value: m,
            label: t(`promotion.mode_${m}`),
            description: t(`agentPromotion.modeHelp_${m}`),
          }))}
        />
        <p class="text-xs">
          <a href="/approvals?tab=promotion" class="text-kitsuden-accent hover:underline"
            >{t("agentPromotion.pipelineLink")}</a
          >
        </p>
        {#if isAdmin()}
          <SaveBar
            sticky={false}
            dirty={mode !== saved}
            {saving}
            disableWhenClean
            saveLabel={t("agentPromotion.save")}
            cancelLabel={t("record.discard")}
            onSave={save}
            onCancel={mode !== saved ? () => (mode = saved) : undefined}
          />
        {:else}
          <Alert variant="warning">{t("approvals.readOnly")}</Alert>
        {/if}
      {/if}
    </CardContent>
  </Card>
</div>
