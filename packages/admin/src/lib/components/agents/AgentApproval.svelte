<!--
  Human approval of ONE agent: inherit (only what is sensitive), «propose
  only» (also what writes) or direct (never asks for approval). With the master
  switch off, no mode holds anything back, and a warning is shown. Only an
  admin changes it; it is audited.
-->
<script lang="ts">
  import {
    Alert,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Field,
    RadioGroup,
    SaveBar,
    Skeleton,
    Textarea,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";

  import { isAdmin } from "$lib/auth.svelte";
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

  const unattendedDirty = $derived(
    unattended !== savedUnattended || alternative !== savedAlternative
  );

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

<div data-testid="agent-approval">
  <Card>
    <CardHeader>
      <CardTitle level={2}>{t("agentApproval.title")}</CardTitle>
      <p class="text-xs text-kitsuden-subtle">
        {t("agentApproval.help", {
          state: globalActive ? t("agentApproval.globalOn") : t("agentApproval.globalOff"),
        })}
      </p>
    </CardHeader>
    <CardContent class="space-y-4">
      {#if !loading && !error && !globalActive && mode !== "direct"}
        <div data-testid="global-off-note">
          <Alert variant="warning">{t("agentApproval.globalOffNote")}</Alert>
        </div>
      {/if}

      {#if loading}
        <Skeleton lines={3} />
      {:else if error}
        <Alert variant="error">{error}</Alert>
      {:else}
        <RadioGroup
          legend={t("agentApproval.title")}
          hideLegend
          name="approval-mode"
          disabled={!isAdmin()}
          value={mode}
          onchange={(v) => (mode = v as ApprovalMode)}
          options={MODES.map((m) => ({
            value: m,
            label: t(`approvals.mode_${m}`),
            description: t(`agentApproval.modeHelp_${m}`),
          }))}
        />
        <p class="text-xs">
          <a href="/approvals" class="text-kitsuden-accent hover:underline"
            >{t("agentApproval.inboxLink")}</a
          >
        </p>
        {#if isAdmin()}
          <SaveBar
            sticky={false}
            dirty={mode !== saved}
            {saving}
            disableWhenClean
            saveLabel={t("agentApproval.save")}
            cancelLabel={t("record.discard")}
            onSave={save}
            onCancel={mode !== saved ? () => (mode = saved) : undefined}
          />
        {:else}
          <Alert variant="warning">{t("approvals.readOnly")}</Alert>
        {/if}

        <div class="pt-4 border-t border-kitsuden-border space-y-3" data-testid="agent-unattended">
          <div>
            <h3 class="text-sm font-semibold text-kitsuden-text">
              {t("agentApproval.unattendedTitle")}
            </h3>
            <p class="text-xs text-kitsuden-subtle">{t("agentApproval.unattendedHelp")}</p>
          </div>
          <RadioGroup
            legend={t("agentApproval.unattendedTitle")}
            hideLegend
            name="unattended"
            disabled={!isAdmin()}
            value={unattended === "" ? "global" : unattended}
            onchange={(v) => (unattended = v === "global" ? "" : (v as UnattendedMode))}
            options={[
              {
                value: "global",
                label: t("agentApproval.unattended_global", {
                  mode: t(`agentApproval.unattended_${globalUnattended}`),
                }),
              },
              { value: "hold", label: t("agentApproval.unattended_hold") },
              { value: "deny", label: t("agentApproval.unattended_deny") },
            ]}
          />
          <Field label={t("agentApproval.alternativeLabel")}>
            <Textarea
              bind:value={alternative}
              rows={2}
              maxlength={1000}
              disabled={!isAdmin()}
              placeholder={t("agentApproval.alternativePlaceholder")}
            />
          </Field>
          {#if isAdmin()}
            <SaveBar
              sticky={false}
              dirty={unattendedDirty}
              saving={savingUnattended}
              disableWhenClean
              saveLabel={t("agentApproval.saveUnattended")}
              cancelLabel={t("record.discard")}
              onSave={saveUnattended}
              onCancel={unattendedDirty
                ? () => {
                    unattended = savedUnattended;
                    alternative = savedAlternative;
                  }
                : undefined}
            />
          {/if}
        </div>
      {/if}
    </CardContent>
  </Card>
</div>
