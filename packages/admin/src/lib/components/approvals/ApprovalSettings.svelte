<!--
  Human approval settings: the MASTER switch (with a
  warning when turning it off if there are agents in «Propose only»), the retention of that
  mode, a proposal's lifetime, each agent's mode, what is sensitive per operation
  (with what the kon declares as the factory value) and the rules for legacy
  routes. Only an admin changes anything; an editor sees it read-only.
-->
<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    EmptyState,
    Field,
    Input,
    NumberInput,
    RadioGroup,
    SaveBar,
    SearchInput,
    Select,
    Skeleton,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import { Switch } from "$lib/tallao";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { Plus, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";

  import { isAdmin } from "$lib/auth.svelte";
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
  let ttl = $state<number | null>(168);
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

  const ttlDirty = $derived(!!settings && ttl !== settings.config.ttlHours);
  const rulesDirty = $derived(
    !!settings && JSON.stringify(rules) !== JSON.stringify(settings.config.legacyRules)
  );
  const SENSITIVITY = $derived([
    { value: "default", label: t("approvals.useDefault") },
    { value: "true", label: t("approvals.sensitive") },
    { value: "false", label: t("approvals.notSensitive") },
  ]);
  const METHODS = ["*", "GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({
    value: m,
    label: m,
  }));

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
    <Skeleton lines={3} />
  {:else if error}
    <Alert variant="error">{error}</Alert>
  {:else if settings}
    {@const a = settings}
    <p class="text-xs text-kitsuden-subtle">{t("approvals.settingsHelp")}</p>
    {#if !editable}
      <Alert variant="warning">{t("approvals.readOnly")}</Alert>
    {/if}

    <!-- Global -->
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <CardTitle level={3}>{t("approvals.globalTitle")}</CardTitle>
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
          <span data-testid="global-state">
            <Badge variant={a.config.enabled ? "success" : "default"} dot>
              {a.config.enabled ? t("approvals.globalOn") : t("approvals.globalOff")}
            </Badge>
          </span>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        {#if !a.config.enabled && watched.length > 0}
          <div data-testid="global-off-warning">
            <Alert variant="warning">
              {t("approvals.globalOffWarning", { names: watched.join(", ") })}
            </Alert>
          </div>
        {/if}
        <div data-testid="propose-retention">
          <RadioGroup
            legend={t("approvals.retentionTitle")}
            name="retention"
            disabled={!editable || saving}
            value={a.config.proposeRetention}
            onchange={(r) => save({ proposeRetention: r as ProposeRetention })}
            options={retentions.map((r) => ({
              value: r,
              label: t(`approvals.retention_${r}`),
              description: t(`approvals.retentionHelp_${r}`),
            }))}
          />
          <p class="text-[11px] text-kitsuden-subtle mt-1.5">{t("approvals.retentionHelp")}</p>
        </div>
        <form
          id="approvals-ttl-form"
          onsubmit={(e) => {
            e.preventDefault();
            save({ ttlHours: Number(ttl) });
          }}
        >
          <Field label={t("approvals.ttl")} class="max-w-40">
            <NumberInput id="ttl" min={1} max={720} bind:value={ttl} disabled={!editable} />
          </Field>
          <p class="text-[11px] text-kitsuden-subtle mt-1">{t("approvals.ttlHelp")}</p>
          {#if editable}
            <SaveBar
              form="approvals-ttl-form"
              sticky={false}
              dirty={ttlDirty}
              {saving}
              disableWhenClean
              saveLabel={t("approvals.save")}
              cancelLabel={t("record.discard")}
              onCancel={ttlDirty ? () => (ttl = a.config.ttlHours) : undefined}
            />
          {/if}
        </form>
        {#if a.updatedAt}
          <p class="text-[11px] text-kitsuden-subtle" data-testid="last-change">
            {t("approvals.lastChange", {
              name: a.updatedByName ?? a.updatedBy ?? "—",
              date: date(a.updatedAt),
            })}
          </p>
        {/if}
      </CardContent>
    </Card>

    <!-- Agents -->
    <Card>
      <CardHeader>
        <CardTitle level={3}>{t("approvals.agentsTitle")}</CardTitle>
        <p class="text-xs text-kitsuden-subtle">{t("approvals.agentsHelp")}</p>
      </CardHeader>
      <CardContent class="space-y-3">
        {#if a.agents.length === 0}
          <EmptyState size="sm" icon={false} level={null} title={t("approvals.noAgents")} />
        {:else}
          <div class="min-w-0">
            <Table class="w-full text-sm">
              <TableBody class="divide-y divide-kitsuden-border/70">
                {#each a.agents as ag (ag.id)}
                  <TableRow data-testid="agent-mode-row">
                    <TableCell class="py-1.5 pr-3 text-kitsuden-text min-w-0">
                      <a href="/agents/{ag.id}?tab=approval" class="hover:underline">{ag.name}</a>
                    </TableCell>
                    <TableCell class="py-1.5 w-48">
                      <Select
                        size="sm"
                        value={ag.mode}
                        disabled={!editable}
                        aria-label={t("approvals.modeFor", { name: ag.name })}
                        onchange={(e: Event) =>
                          changeMode(
                            ag.id,
                            ag.name,
                            (e.currentTarget as HTMLSelectElement).value as ApprovalMode
                          )}
                        options={a.modes.map((m) => ({
                          value: m,
                          label: t(`approvals.mode_${m}`),
                        }))}
                      />
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          </div>
        {/if}
      </CardContent>
    </Card>

    <!-- SDK operations -->
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-0 flex-1">
            <CardTitle level={3}>{t("approvals.operationsTitle")}</CardTitle>
            <p class="text-xs text-kitsuden-subtle">{t("approvals.operationsHelp")}</p>
          </div>
          <SearchInput
            class="w-full sm:w-56"
            bind:value={opsFilter}
            placeholder={t("approvals.filterOps")}
            ariaLabel={t("approvals.filterOps")}
          />
        </div>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="max-h-96 overflow-y-auto min-w-0">
          <Table class="w-full text-xs">
            <TableHeader class="text-kitsuden-subtle sticky top-0 bg-kitsuden-card">
              <TableRow>
                <TableHead class="text-left px-2 py-1.5">{t("approvals.colOperation")}</TableHead>
                <TableHead class="text-left px-2 py-1.5">{t("approvals.colDefault")}</TableHead>
                <TableHead class="text-left px-2 py-1.5">{t("approvals.colSetting")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody class="divide-y divide-kitsuden-border/70">
              {#each filteredOperations as o (o.key)}
                <TableRow data-testid="operation-row" data-key={o.key}>
                  <TableCell class="px-2 py-1.5 min-w-0">
                    <code class="text-kitsuden-text break-all">{o.method} {o.path}</code>
                    <div class="text-kitsuden-subtle break-all">{o.key}</div>
                    {#if o.readOnly && o.method !== "GET"}
                      <Badge variant="info" data-testid="read-only-post"
                        >{t("approvals.readOnlyPost")}</Badge
                      >
                    {/if}
                  </TableCell>
                  <TableCell
                    class="px-2 py-1.5 whitespace-nowrap {o.default
                      ? 'text-kitsuden-amber'
                      : 'text-kitsuden-text-dim'}"
                  >
                    {o.default ? t("approvals.sensitive") : t("approvals.notSensitive")}
                  </TableCell>
                  <TableCell class="px-2 py-1.5 w-44">
                    <Select
                      size="sm"
                      value={valueFor(o.override)}
                      disabled={!editable || saving}
                      aria-label={t("approvals.settingFor", { name: o.key })}
                      onchange={(e: Event) =>
                        save({
                          operations: {
                            [o.key]: fromValue((e.currentTarget as HTMLSelectElement).value),
                          },
                        })}
                      options={SENSITIVITY}
                    />
                  </TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <!-- Core MCP tools -->
    <Card>
      <CardHeader>
        <CardTitle level={3}>{t("approvals.toolsTitle")}</CardTitle>
        <p class="text-xs text-kitsuden-subtle">{t("approvals.toolsHelp")}</p>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="min-w-0">
          <Table class="w-full text-xs">
            <TableBody class="divide-y divide-kitsuden-border/70">
              {#each a.mcpTools as h (h.key)}
                <TableRow>
                  <TableCell class="px-2 py-1.5"
                    ><code class="text-kitsuden-text">{h.name}</code></TableCell
                  >
                  <TableCell class="px-2 py-1.5 text-kitsuden-subtle"
                    >{h.write ? t("approvals.writes") : t("approvals.reads")}</TableCell
                  >
                  <TableCell
                    class="px-2 py-1.5 whitespace-nowrap {h.default
                      ? 'text-kitsuden-amber'
                      : 'text-kitsuden-text-dim'}"
                  >
                    {h.default ? t("approvals.sensitive") : t("approvals.notSensitive")}
                  </TableCell>
                  <TableCell class="px-2 py-1.5 w-44">
                    <Select
                      size="sm"
                      value={valueFor(h.override)}
                      disabled={!editable || saving}
                      aria-label={t("approvals.settingFor", { name: h.name })}
                      onchange={(e: Event) =>
                        save({
                          operations: {
                            [h.key]: fromValue((e.currentTarget as HTMLSelectElement).value),
                          },
                        })}
                      options={SENSITIVITY}
                    />
                  </TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <!-- Legacy routes -->
    <Card>
      <CardHeader>
        <CardTitle level={3}>{t("approvals.legacyTitle")}</CardTitle>
        <p class="text-xs text-kitsuden-subtle">{t("approvals.legacyHelp")}</p>
      </CardHeader>
      <CardContent class="space-y-3">
        {#if rules.length === 0}
          <EmptyState size="sm" icon={false} level={null} title={t("approvals.noRules")} />
        {/if}
        {#each rules as rule, i}
          <div class="flex flex-wrap items-center gap-2" data-testid="legacy-rule">
            <Select
              class="w-28"
              width="auto"
              bind:value={rule.method}
              disabled={!editable}
              aria-label={t("approvals.method")}
              options={METHODS}
            />
            <Input
              class="flex-1 min-w-48 font-mono"
              bind:value={rule.path}
              disabled={!editable}
              aria-label={t("approvals.path")}
            />
            {#if editable}
              <Button
                variant="danger-ghost"
                size="sm"
                onclick={() => (rules = rules.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} aria-hidden="true" />{t("approvals.removeRule")}
              </Button>
            {/if}
          </div>
        {/each}
        {#if editable}
          <SaveBar
            sticky={false}
            dirty={rulesDirty}
            {saving}
            disableWhenClean
            saveLabel={t("approvals.saveRules")}
            cancelLabel={t("record.discard")}
            onSave={() => save({ legacyRules: rules })}
            onCancel={rulesDirty
              ? () => (rules = a.config.legacyRules.map((r) => ({ ...r })))
              : undefined}
          >
            <Button
              variant="secondary"
              size="sm"
              onclick={() => (rules = [...rules, { method: "DELETE", path: "/api/" }])}
            >
              <Plus size={14} aria-hidden="true" />{t("approvals.addRule")}
            </Button>
          </SaveBar>
        {/if}
      </CardContent>
    </Card>
  {/if}
</div>
