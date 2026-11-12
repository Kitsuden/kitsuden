<!--
  An agent's human signer: the account
  (admin or editor) that SIGNS what the agent creates — author of blog
  entries, owner of dataset entries —. Chosen by an admin. If that account
  is deleted or loses its role, the agent does not create signed content until
  it is reassigned.
-->
<script lang="ts">
  import {
    Alert,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Field,
    SaveBar,
    Select,
    Skeleton,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { UserX } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";

  import { isAdmin } from "$lib/auth.svelte";
  import { getAgentSponsor, setAgentSponsor } from "$lib/services/agents";
  import type { AgentSponsor } from "$lib/types/agents";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  let data = $state<AgentSponsor | null>(null);
  let chosenItem = $state<string>("");
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const dirty = $derived(!!data && chosenItem !== (data.sponsor?.userId ?? ""));

  onMount(load);

  function fill(d: AgentSponsor) {
    data = d;
    chosenItem = d.sponsor?.userId ?? "";
  }

  async function load() {
    try {
      loading = true;
      error = null;
      fill(await getAgentSponsor(agentId));
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentSponsor.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function save(userId: string | null) {
    try {
      saving = true;
      fill(await setAgentSponsor(agentId, userId));
      toast.success(userId ? t("agentSponsor.saved") : t("agentSponsor.removed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentSponsor.errorSaving"));
    } finally {
      saving = false;
    }
  }

  const ROLE: Record<string, () => string> = {
    admin: () => t("agentSponsor.roleAdmin"),
    editor: () => t("agentSponsor.roleEditor"),
  };
</script>

<div data-testid="agent-sponsor">
  <Card>
    <CardHeader>
      <CardTitle level={2}>{t("agentSponsor.title")}</CardTitle>
      <p class="text-xs text-kitsuden-subtle">{t("agentSponsor.help")}</p>
    </CardHeader>
    <CardContent class="space-y-4">
      {#if loading}
        <Skeleton lines={3} />
      {:else if error}
        <Alert variant="error">{error}</Alert>
      {:else if data}
        <div
          class="p-3 rounded-lg border {data.sponsor && !data.sponsor.valid
            ? 'border-kitsuden-danger/40 bg-kitsuden-danger/5'
            : 'border-kitsuden-border'}"
          data-testid="sponsor-current"
        >
          {#if !data.sponsor}
            <p class="text-sm text-kitsuden-text-dim">{t("agentSponsor.none")}</p>
            <p class="text-xs text-kitsuden-subtle">{t("agentSponsor.noneHelp")}</p>
          {:else}
            <p class="text-sm text-kitsuden-text">
              {data.sponsor.name ?? data.sponsor.userId}
              {#if data.sponsor.email}<span class="text-xs text-kitsuden-subtle ml-1"
                  >{data.sponsor.email}</span
                >{/if}
            </p>
            {#if data.sponsor.valid}
              <p class="text-xs text-kitsuden-green">
                {t("agentSponsor.valid", {
                  role: ROLE[data.sponsor.role ?? ""]?.() ?? data.sponsor.role ?? "",
                })}
              </p>
            {:else}
              <p class="text-xs text-kitsuden-danger" data-testid="sponsor-invalid">
                {data.sponsor.reason === "not_found"
                  ? t("agentSponsor.invalidDeleted")
                  : t("agentSponsor.invalidRole")}
              </p>
            {/if}
          {/if}
        </div>

        <ul class="text-xs text-kitsuden-subtle list-disc pl-5 space-y-1">
          <li>{t("agentSponsor.rule1")}</li>
          <li>{t("agentSponsor.rule2")}</li>
          <li>{t("agentSponsor.rule3")}</li>
        </ul>

        {#if isAdmin()}
          <Field label={t("agentSponsor.choose")}>
            <Select
              id="sponsor-select"
              bind:value={chosenItem}
              placeholder={t("agentSponsor.nobody")}
              options={data.candidates.map((c) => ({
                value: c.id,
                label: t("agentSponsor.candidate", {
                  name: c.name,
                  email: c.email,
                  role: ROLE[c.role]?.() ?? c.role,
                }),
              }))}
            />
          </Field>
          <SaveBar
            sticky={false}
            {dirty}
            {saving}
            disableWhenClean
            saveLabel={t("agentSponsor.save")}
            cancelLabel={t("record.discard")}
            onSave={() => save(chosenItem || null)}
            onCancel={dirty ? () => (chosenItem = data?.sponsor?.userId ?? "") : undefined}
          >
            {#if data.sponsor}
              <Button variant="danger-ghost" size="sm" disabled={saving} onclick={() => save(null)}>
                <UserX size={14} aria-hidden="true" />{t("agentSponsor.remove")}
              </Button>
            {/if}
          </SaveBar>
        {:else}
          <Alert variant="warning">{t("agentSponsor.readOnly")}</Alert>
        {/if}
      {/if}
    </CardContent>
  </Card>
</div>
