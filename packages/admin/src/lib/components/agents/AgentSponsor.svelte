<!--
  An agent's human signer: the account
  (admin or editor) that SIGNS what the agent creates — author of blog
  entries, owner of dataset entries —. Chosen by an admin. If that account
  is deleted or loses its role, the agent does not create signed content until
  it is reassigned.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save, UserX } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { isAdmin } from "$lib/auth.svelte";
  import Button from "$lib/components/ui/Button.svelte";
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

<div class="space-y-4" data-testid="agent-sponsor">
  <div>
    <h3 class="text-sm font-semibold text-zinc-300">{t("agentSponsor.title")}</h3>
    <p class="text-xs text-zinc-500">{t("agentSponsor.help")}</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if data}
    <div
      class="p-3 rounded-lg border {data.sponsor && !data.sponsor.valid
        ? 'border-red-500/40 bg-red-500/5'
        : 'border-zinc-800'}"
      data-testid="sponsor-current"
    >
      {#if !data.sponsor}
        <p class="text-sm text-zinc-400">{t("agentSponsor.none")}</p>
        <p class="text-xs text-zinc-500">{t("agentSponsor.noneHelp")}</p>
      {:else}
        <p class="text-sm text-zinc-200">
          {data.sponsor.name ?? data.sponsor.userId}
          {#if data.sponsor.email}<span class="text-xs text-zinc-500 ml-1"
              >{data.sponsor.email}</span
            >{/if}
        </p>
        {#if data.sponsor.valid}
          <p class="text-xs text-emerald-300">
            {t("agentSponsor.valid", {
              role: ROLE[data.sponsor.role ?? ""]?.() ?? data.sponsor.role ?? "",
            })}
          </p>
        {:else}
          <p class="text-xs text-red-300" data-testid="sponsor-invalid">
            {data.sponsor.reason === "not_found"
              ? t("agentSponsor.invalidDeleted")
              : t("agentSponsor.invalidRole")}
          </p>
        {/if}
      {/if}
    </div>

    {#if isAdmin()}
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-64 flex-1">
          <label for="sponsor-select" class="block text-sm text-zinc-300 mb-1.5"
            >{t("agentSponsor.choose")}</label
          >
          <select
            id="sponsor-select"
            bind:value={chosenItem}
            class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100"
          >
            <option value="">{t("agentSponsor.nobody")}</option>
            {#each data.candidates as c (c.id)}
              <option value={c.id}
                >{t("agentSponsor.candidate", {
                  name: c.name,
                  email: c.email,
                  role: ROLE[c.role]?.() ?? c.role,
                })}</option
              >
            {/each}
          </select>
        </div>
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={chosenItem === (data.sponsor?.userId ?? "")}
          onclick={() => save(chosenItem || null)}
        >
          <Save size={14} class="mr-1" />{t("agentSponsor.save")}
        </Button>
        {#if data.sponsor}
          <Button
            variant="ghost"
            size="sm"
            class="text-red-400"
            disabled={saving}
            onclick={() => save(null)}
          >
            <UserX size={14} class="mr-1" />{t("agentSponsor.remove")}
          </Button>
        {/if}
      </div>
    {:else}
      <p class="text-xs text-amber-300/80">{t("agentSponsor.readOnly")}</p>
    {/if}
    <ul class="text-xs text-zinc-500 list-disc pl-5 space-y-1">
      <li>{t("agentSponsor.rule1")}</li>
      <li>{t("agentSponsor.rule2")}</li>
      <li>{t("agentSponsor.rule3")}</li>
    </ul>
  {/if}
</div>
