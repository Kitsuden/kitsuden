<!--
  Human approval settings: the MASTER switch (with a
  warning when turning it off if there are agents in «Propose only»), the retention of that
  mode, a proposal's lifetime, each agent's mode, what is sensitive per operation
  (with what the kon declares as the factory value) and the rules for legacy
  routes. Only an admin changes anything; an editor sees it read-only.
-->
<script lang="ts">
  import { Switch } from "$lib/tallao";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { Plus, Save, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { isAdmin } from "$lib/auth.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import {
    getApprovalSettings,
    saveApprovalSettings,
    setAgentApprovalMode,
  } from "$lib/services/approvals";
  import type {
    ApprovalMode,
    ApprovalSettings,
    LegacyRule,
    ProposeRetention,
  } from "$lib/types/approvals";

  let settings = $state<ApprovalSettings | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let ttl = $state<number>(168);
  let rules = $state<LegacyRule[]>([]);
  let opsFilter = $state("");
  const editable = $derived(isAdmin());

  onMount(load);

  function fill(a: ApprovalSettings) {
    settings = a;
    ttl = a.config.ttlHours;
    rules = a.config.legacyRules.map((r) => ({ ...r }));
  }

  async function load() {
    try {
      loading = true;
      error = null;
      fill(await getApprovalSettings());
    } catch (e) {
      error = e instanceof Error ? e.message : t("approvals.errorLoading");
    } finally {
      loading = false;
    }
  }

  async function save(change: Parameters<typeof saveApprovalSettings>[0]) {
    try {
      saving = true;
      fill(await saveApprovalSettings(change));
      toast.success(t("approvals.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorSaving"));
    } finally {
      saving = false;
    }
  }

  /** The general one is the MASTER switch: turning it off also releases the monitored ones. */
  const retentions = $derived<ProposeRetention[]>(settings?.retentions ?? ["selective", "strict"]);
  const watched = $derived(
    (settings?.agents ?? []).filter((x) => x.mode === "propose").map((x) => x.name)
  );

  async function changeGlobal() {
    if (!settings) return;
    const turnOff = settings.config.enabled;
    if (
      turnOff &&
      watched.length > 0 &&
      !(await confirmDialog(t("approvals.confirmTurnOff", { names: watched.join(", ") })))
    )
      return;
    save({ enabled: !turnOff });
  }

  async function changeMode(agentId: string, name: string, mode: ApprovalMode) {
    try {
      await setAgentApprovalMode(agentId, mode);
      toast.success(t("approvals.modeSaved", { name: name }));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("approvals.errorSaving"));
    }
  }

  /** `true`/`false` = changed by the admin; `default` = what the kon declares. */
  function valueFor(override: boolean | null): string {
    return override === null ? "default" : override ? "true" : "false";
  }
  function fromValue(v: string): boolean | null {
    return v === "default" ? null : v === "true";
  }

  const filteredOperations = $derived(
    (settings?.operations ?? []).filter((o) => {
      const f = opsFilter.trim().toLowerCase();
      return !f || `${o.key} ${o.method} ${o.path} ${o.summary}`.toLowerCase().includes(f);
    })
  );

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
</script>

<div class="space-y-6" data-testid="approvals-settings">
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
  {:else if settings}
    {@const a = settings}
    <p class="text-xs text-kitsuden-subtle">{t("approvals.settingsHelp")}</p>
    {#if !editable}
      <p class="text-xs text-kitsuden-amber">{t("approvals.readOnly")}</p>
    {/if}

    <!-- Global -->
    <section class="border border-kitsuden-border rounded-lg p-4 space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-kitsuden-text">{t("approvals.globalTitle")}</h3>
          <p class="text-xs text-kitsuden-subtle">{t("approvals.globalHelp")}</p>
        </div>
        <!--
          Controlled: the getter is the saved setting, so a cancelled confirmation (or a
          failed save) leaves the switch where it was instead of where the click put it.
        -->
        <span data-testid="global-switch">
          <Switch
            bind:checked={() => a.config.enabled, () => void changeGlobal()}
            ariaLabel={t("approvals.globalTitle")}
            disabled={!editable || saving}
          />
        </span>
        <span
          class="text-sm {a.config.enabled ? 'text-kitsuden-green' : 'text-kitsuden-text-dim'}"
          data-testid="global-state"
        >
          {a.config.enabled ? t("approvals.globalOn") : t("approvals.globalOff")}
        </span>
      </div>
      {#if !a.config.enabled && watched.length > 0}
        <p
          class="text-xs text-kitsuden-amber bg-kitsuden-amber/10 border border-kitsuden-amber/20 rounded-sm px-3 py-2"
          data-testid="global-off-warning"
        >
          {t("approvals.globalOffWarning", { names: watched.join(", ") })}
        </p>
      {/if}
      <fieldset class="space-y-1.5" disabled={!editable || saving} data-testid="propose-retention">
        <legend class="text-xs text-kitsuden-text-dim mb-1">{t("approvals.retentionTitle")}</legend>
        {#each retentions as r}
          <label class="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              name="retention"
              value={r}
              checked={a.config.proposeRetention === r}
              onchange={() => save({ proposeRetention: r })}
              class="mt-0.5"
            />
            <span>
              <span class="text-kitsuden-text">{t(`approvals.retention_${r}`)}</span>
              <span class="block text-kitsuden-subtle">{t(`approvals.retentionHelp_${r}`)}</span>
            </span>
          </label>
        {/each}
        <p class="text-[11px] text-kitsuden-subtle">{t("approvals.retentionHelp")}</p>
      </fieldset>
      <form
        class="flex flex-wrap items-end gap-3"
        onsubmit={(e) => {
          e.preventDefault();
          save({ ttlHours: Number(ttl) });
        }}
      >
        <div>
          <label for="ttl" class="block text-xs text-kitsuden-text-dim mb-1"
            >{t("approvals.ttl")}</label
          >
          <input
            id="ttl"
            type="number"
            min="1"
            max="720"
            bind:value={ttl}
            disabled={!editable}
            class="w-32 px-3 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
          />
        </div>
        {#if editable}
          <Button type="submit" variant="secondary" size="sm" loading={saving}>
            <Save size={14} class="mr-1" />{t("approvals.save")}
          </Button>
        {/if}
        <p class="text-[11px] text-kitsuden-subtle basis-full">{t("approvals.ttlHelp")}</p>
      </form>
      {#if a.updatedAt}
        <p class="text-[11px] text-kitsuden-subtle" data-testid="last-change">
          {t("approvals.lastChange", {
            name: a.updatedByName ?? a.updatedBy ?? "—",
            date: date(a.updatedAt),
          })}
        </p>
      {/if}
    </section>

    <!-- Agents -->
    <section class="border border-kitsuden-border rounded-lg p-4 space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("approvals.agentsTitle")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("approvals.agentsHelp")}</p>
      </div>
      {#if a.agents.length === 0}
        <p class="text-xs text-kitsuden-subtle">{t("approvals.noAgents")}</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <tbody class="divide-y divide-kitsuden-border/70">
              {#each a.agents as ag (ag.id)}
                <tr data-testid="agent-mode-row">
                  <td class="py-1.5 pr-3 text-kitsuden-text min-w-0">
                    <a href="/agents/{ag.id}?tab=approval" class="hover:underline">{ag.name}</a>
                  </td>
                  <td class="py-1.5 w-48">
                    <select
                      value={ag.mode}
                      disabled={!editable}
                      aria-label={t("approvals.modeFor", { name: ag.name })}
                      onchange={(e) =>
                        changeMode(
                          ag.id,
                          ag.name,
                          (e.currentTarget as HTMLSelectElement).value as ApprovalMode
                        )}
                      class="w-full px-2 py-1 bg-kitsuden-bg border border-kitsuden-input rounded-sm text-xs text-kitsuden-text"
                    >
                      {#each a.modes as m}
                        <option value={m}>{t(`approvals.mode_${m}`)}</option>
                      {/each}
                    </select>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- SDK operations -->
    <section class="border border-kitsuden-border rounded-lg p-4 space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-kitsuden-text">{t("approvals.operationsTitle")}</h3>
          <p class="text-xs text-kitsuden-subtle">{t("approvals.operationsHelp")}</p>
        </div>
        <input
          type="search"
          bind:value={opsFilter}
          placeholder={t("approvals.filterOps")}
          aria-label={t("approvals.filterOps")}
          class="w-56 px-3 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
        />
      </div>
      <div
        class="overflow-x-auto max-h-96 overflow-y-auto border border-kitsuden-border rounded-sm"
      >
        <table class="w-full text-xs">
          <thead class="text-kitsuden-subtle sticky top-0 bg-kitsuden-card">
            <tr>
              <th class="text-left px-2 py-1.5">{t("approvals.colOperation")}</th>
              <th class="text-left px-2 py-1.5">{t("approvals.colDefault")}</th>
              <th class="text-left px-2 py-1.5">{t("approvals.colSetting")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-kitsuden-border/70">
            {#each filteredOperations as o (o.key)}
              <tr data-testid="operation-row" data-key={o.key}>
                <td class="px-2 py-1.5 min-w-0">
                  <code class="text-kitsuden-text break-all">{o.method} {o.path}</code>
                  <div class="text-kitsuden-subtle break-all">{o.key}</div>
                  {#if o.readOnly && o.method !== "GET"}
                    <span
                      class="inline-block mt-0.5 px-1.5 rounded-sm bg-kitsuden-info/10 text-kitsuden-info text-xs"
                      data-testid="read-only-post">{t("approvals.readOnlyPost")}</span
                    >
                  {/if}
                </td>
                <td
                  class="px-2 py-1.5 whitespace-nowrap {o.default
                    ? 'text-kitsuden-amber'
                    : 'text-kitsuden-text-dim'}"
                >
                  {o.default ? t("approvals.sensitive") : t("approvals.notSensitive")}
                </td>
                <td class="px-2 py-1.5 w-44">
                  <select
                    value={valueFor(o.override)}
                    disabled={!editable || saving}
                    aria-label={t("approvals.settingFor", { name: o.key })}
                    onchange={(e) =>
                      save({
                        operations: {
                          [o.key]: fromValue((e.currentTarget as HTMLSelectElement).value),
                        },
                      })}
                    class="w-full px-2 py-1 bg-kitsuden-bg border rounded text-xs text-kitsuden-text {o.override ===
                    null
                      ? 'border-kitsuden-input'
                      : 'border-kitsuden-accent/60'}"
                  >
                    <option value="default">{t("approvals.useDefault")}</option>
                    <option value="true">{t("approvals.sensitive")}</option>
                    <option value="false">{t("approvals.notSensitive")}</option>
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Core MCP tools -->
    <section class="border border-kitsuden-border rounded-lg p-4 space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("approvals.toolsTitle")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("approvals.toolsHelp")}</p>
      </div>
      <div class="overflow-x-auto border border-kitsuden-border rounded-sm">
        <table class="w-full text-xs">
          <tbody class="divide-y divide-kitsuden-border/70">
            {#each a.mcpTools as h (h.key)}
              <tr>
                <td class="px-2 py-1.5"><code class="text-kitsuden-text">{h.name}</code></td>
                <td class="px-2 py-1.5 text-kitsuden-subtle"
                  >{h.write ? t("approvals.writes") : t("approvals.reads")}</td
                >
                <td
                  class="px-2 py-1.5 whitespace-nowrap {h.default
                    ? 'text-kitsuden-amber'
                    : 'text-kitsuden-text-dim'}"
                >
                  {h.default ? t("approvals.sensitive") : t("approvals.notSensitive")}
                </td>
                <td class="px-2 py-1.5 w-44">
                  <select
                    value={valueFor(h.override)}
                    disabled={!editable || saving}
                    aria-label={t("approvals.settingFor", { name: h.name })}
                    onchange={(e) =>
                      save({
                        operations: {
                          [h.key]: fromValue((e.currentTarget as HTMLSelectElement).value),
                        },
                      })}
                    class="w-full px-2 py-1 bg-kitsuden-bg border rounded text-xs text-kitsuden-text {h.override ===
                    null
                      ? 'border-kitsuden-input'
                      : 'border-kitsuden-accent/60'}"
                  >
                    <option value="default">{t("approvals.useDefault")}</option>
                    <option value="true">{t("approvals.sensitive")}</option>
                    <option value="false">{t("approvals.notSensitive")}</option>
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Legacy routes -->
    <section class="border border-kitsuden-border rounded-lg p-4 space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("approvals.legacyTitle")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("approvals.legacyHelp")}</p>
      </div>
      {#if rules.length === 0}
        <p class="text-xs text-kitsuden-subtle">{t("approvals.noRules")}</p>
      {/if}
      {#each rules as rule, i}
        <div class="flex flex-wrap items-center gap-2" data-testid="legacy-rule">
          <select
            bind:value={rule.method}
            disabled={!editable}
            aria-label={t("approvals.method")}
            class="w-28 px-2 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-sm text-xs text-kitsuden-text"
          >
            {#each ["*", "GET", "POST", "PUT", "PATCH", "DELETE"] as m}
              <option value={m}>{m}</option>
            {/each}
          </select>
          <input
            bind:value={rule.path}
            disabled={!editable}
            aria-label={t("approvals.path")}
            class="flex-1 min-w-48 px-3 py-1.5 bg-kitsuden-bg border border-kitsuden-input rounded-sm text-xs text-kitsuden-text font-mono"
          />
          {#if editable}
            <Button
              variant="ghost"
              size="sm"
              class="text-kitsuden-danger"
              onclick={() => (rules = rules.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} class="mr-1" />{t("approvals.removeRule")}
            </Button>
          {/if}
        </div>
      {/each}
      {#if editable}
        <div class="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onclick={() => (rules = [...rules, { method: "DELETE", path: "/api/" }])}
          >
            <Plus size={14} class="mr-1" />{t("approvals.addRule")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onclick={() => save({ legacyRules: rules })}
          >
            <Save size={14} class="mr-1" />{t("approvals.saveRules")}
          </Button>
        </div>
      {/if}
    </section>
  {/if}
</div>
