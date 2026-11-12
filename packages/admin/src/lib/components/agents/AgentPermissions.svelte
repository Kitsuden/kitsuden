<!--
  An agent's permissions

  Two ways of editing the SAME list of scopes:
    · «Broad»: presets (replace the list) and broad scopes, each with
      what it actually grants (operations and datasets it opens, computed by the API).
    · «Fine»: one row per kon SDK operation and per dataset × action, with
      Allow / Deny. Deny writes `!scope`: it beats everything, admin included.
  And the merged view «What it can do», computed by the API with the SAVED
  list (broad ∪ fine − denied). The rule: docs/agents/permissions.md.
-->
<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    SaveBar,
    Select,
    Skeleton,
    Tabs,
    Textarea,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import UnsavedGuard from "$lib/components/feedback/UnsavedGuard.svelte";
  import { t } from "$lib/i18n";
  import { Check, Ban, ShieldCheck } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";
  import { getAccessCatalog, getAgentAccess, setAgentScopes } from "$lib/services/agents";
  import type { AccessCatalog, AgentAccess, AccessState } from "$lib/types/agents";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  let catalog = $state<AccessCatalog | null>(null);
  let access = $state<AgentAccess | null>(null);
  let draft = $state<string[]>([]);
  let mode = $state<"broad" | "fine" | "raw">("broad");
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let rawValue = $state("");

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      [catalog, access] = await Promise.all([getAccessCatalog(), getAgentAccess(agentId)]);
      draft = [...access.scopes];
      rawValue = draft.join("\n");
      // If it already has fine-grained entries (or denials), it opens in fine mode.
      if (draft.some((s) => s.startsWith("!") || s.startsWith("kon:") || /^datasets:[^*]/.test(s)))
        mode = "fine";
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentAccess.errorLoading");
    } finally {
      loading = false;
    }
  }

  const parseRaw = (text: string) =>
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

  // In raw mode the textarea is the draft until it is saved or the mode changes.
  const changed = $derived(
    access
      ? (mode === "raw" ? parseRaw(rawValue) : draft).join("\n") !== access.scopes.join("\n")
      : false
  );

  function switchMode(next: string) {
    if (mode === "raw") draft = parseRaw(rawValue);
    mode = next as typeof mode;
    rawValue = draft.join("\n");
  }

  const CHOICES = $derived([
    { value: "none", label: t("agentAccess.choiceNone") },
    { value: "allow", label: t("agentAccess.choiceAllow") },
    { value: "deny", label: t("agentAccess.choiceDeny") },
  ]);

  async function save() {
    if (mode === "raw") draft = parseRaw(rawValue);
    try {
      saving = true;
      access = await setAgentScopes(agentId, draft);
      draft = [...access.scopes];
      rawValue = draft.join("\n");
      toast.success(t("agentAccess.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentAccess.errorSaving"));
    } finally {
      saving = false;
    }
  }

  function undo() {
    if (!access) return;
    draft = [...access.scopes];
    rawValue = draft.join("\n");
  }

  // ── Broad ──
  const PRESET_TEXTS: Record<string, { name: () => string; desc: () => string }> = {
    "connect-only": {
      name: () => t("agentAccess.presetConnectOnly"),
      desc: () => t("agentAccess.presetConnectOnlyDesc"),
    },
    "read-only": {
      name: () => t("agentAccess.presetReadOnly"),
      desc: () => t("agentAccess.presetReadOnlyDesc"),
    },
    "content-editor": {
      name: () => t("agentAccess.presetContentEditor"),
      desc: () => t("agentAccess.presetContentEditorDesc"),
    },
    "data-editor": {
      name: () => t("agentAccess.presetDataEditor"),
      desc: () => t("agentAccess.presetDataEditorDesc"),
    },
    "full-admin": {
      name: () => t("agentAccess.presetFullAdmin"),
      desc: () => t("agentAccess.presetFullAdminDesc"),
    },
  };

  const BROAD_DESCRIPTION: Record<string, () => string> = {
    admin: () => t("agentAccess.broadAdmin"),
    "mcp:connect": () => t("agentAccess.broadMcpConnect"),
    "mcp:read": () => t("agentAccess.broadMcpRead"),
    "mcp:write": () => t("agentAccess.broadMcpWrite"),
    "mcp:admin": () => t("agentAccess.broadMcpAdmin"),
    "content:edit": () => t("agentAccess.broadContentEdit"),
    "memory:read": () => t("agentAccess.broadMemoryRead"),
    "memory:write": () => t("agentAccess.broadMemoryWrite"),
    "brain:read": () => t("agentAccess.broadBrainRead"),
    "brain:write": () => t("agentAccess.broadBrainWrite"),
    "promotion:propose": () => t("agentAccess.broadPromotionPropose"),
    "kon:*": () => t("agentAccess.broadAllKonOps"),
    "datasets:*:read": () => t("agentAccess.broadAllDatasetsRead"),
    "datasets:*:write": () => t("agentAccess.broadAllDatasetsWrite"),
    "datasets:*:delete": () => t("agentAccess.broadAllDatasetsDelete"),
  };

  function broadDescription(scope: string): string {
    const sets = BROAD_DESCRIPTION[scope];
    if (sets) return sets();
    const kon = scope.endsWith(":*") ? scope.slice(0, -2) : scope;
    return t("agentAccess.broadKonWide", { kon });
  }

  function applyPreset(scopes: readonly string[]) {
    draft = [...scopes];
    rawValue = draft.join("\n");
  }

  function toggle(scope: string, active: boolean) {
    draft = active ? [...new Set([...draft, scope])] : draft.filter((s) => s !== scope);
    rawValue = draft.join("\n");
  }

  // ── Fine-grained ──
  type Choice = "none" | "allow" | "deny";
  function choiceOf(scope: string): Choice {
    if (draft.includes(`!${scope}`)) return "deny";
    if (draft.includes(scope)) return "allow";
    return "none";
  }
  function choose(scope: string, e: Choice) {
    const without = draft.filter((s) => s !== scope && s !== `!${scope}`);
    draft =
      e === "allow" ? [...without, scope] : e === "deny" ? [...without, `!${scope}`] : without;
    rawValue = draft.join("\n");
  }

  const ACTIONS = ["read", "write", "delete"] as const;
  const ACTION_NAME: Record<(typeof ACTIONS)[number], () => string> = {
    read: () => t("agentAccess.actionRead"),
    write: () => t("agentAccess.actionWrite"),
    delete: () => t("agentAccess.actionDelete"),
  };

  // ── Merged view ──
  type Tone = "success" | "error" | "info" | "warning" | "default";
  const STATUS: Record<AccessState, { text: () => string; kind: Tone }> = {
    granted: {
      text: () => t("agentAccess.stateGranted"),
      kind: "success",
    },
    denied: {
      text: () => t("agentAccess.stateDenied"),
      kind: "error",
    },
    open: {
      text: () => t("agentAccess.stateOpen"),
      kind: "info",
    },
    policy: {
      text: () => t("agentAccess.statePolicy"),
      kind: "warning",
    },
    none: {
      text: () => t("agentAccess.stateNone"),
      kind: "default",
    },
  };

  const summary = $derived.by(() => {
    const ops = access?.operations ?? [];
    return {
      granted: ops.filter((o) => o.state === "granted").length,
      deniedMany: ops.filter((o) => o.state === "denied").length,
      policy: ops.filter((o) => o.state === "policy").length,
      total: ops.length,
    };
  });

  const opsWithPermission = $derived(
    (access?.operations ?? []).filter((o) => o.state === "granted" || o.state === "denied")
  );

  /** What is granted/denied, grouped by kon (a flat list of 80 rows is unreadable). */
  const byKon = $derived.by(() => {
    const groups = new Map<string, typeof opsWithPermission>();
    for (const o of opsWithPermission) groups.set(o.kon, [...(groups.get(o.kon) ?? []), o]);
    return [...groups.entries()].map(([kon, ops]) => ({
      kon,
      ops,
      granted: ops.filter((o) => o.state === "granted").length,
      deniedMany: ops.filter((o) => o.state === "denied").length,
    }));
  });

  // Which kons are expanded in fine mode. With  fixed, each
  // change to the list refolded them and the chosen row disappeared.
  let deployed = $state<Record<string, boolean>>({});
</script>

<!-- Unsaved permission changes: ask before leaving the page or the tab. -->
<UnsavedGuard dirty={changed} watchParam="tab" message={t("agentAccess.unsavedLeave")} />

<div class="space-y-6" data-testid="agent-permissions">
  {#if loading}
    <Skeleton lines={3} />
  {:else if error}
    <Alert variant="error">{error}</Alert>
  {:else if catalog && access}
    <!-- Mode -->
    <Tabs
      items={[
        { id: "broad", label: t("agentAccess.modeBroad") },
        { id: "fine", label: t("agentAccess.modeFine") },
        { id: "raw", label: t("agentAccess.modeRaw") },
      ]}
      value={mode}
      variant="pills"
      panels={false}
      ariaLabel={t("agentAccess.modeLabel")}
      onchange={switchMode}
    />

    <p class="text-sm text-kitsuden-subtle">{t("agentAccess.unionRule")}</p>

    {#if mode === "broad"}
      <!-- Presets -->
      <section class="space-y-3">
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentAccess.presets")}</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {#each catalog.presets as p (p.id)}
            <Card class="p-4 min-w-0 space-y-2">
              <div class="flex items-center gap-2">
                <ShieldCheck size={16} class="text-kitsuden-accent shrink-0" />
                <h4 class="font-medium text-kitsuden-text">{PRESET_TEXTS[p.id]?.name() ?? p.id}</h4>
              </div>
              <p class="text-sm text-kitsuden-text-dim">{PRESET_TEXTS[p.id]?.desc() ?? ""}</p>
              <div class="flex flex-wrap gap-1">
                {#each p.scopes as s (s)}
                  <code
                    class="text-[11px] px-1.5 py-0.5 rounded-sm bg-kitsuden-border text-kitsuden-text"
                    >{s}</code
                  >
                {/each}
              </div>
              <Button variant="secondary" size="sm" onclick={() => applyPreset(p.scopes)}>
                {t("agentAccess.applyPreset")}
              </Button>
            </Card>
          {/each}
        </div>
        <p class="text-xs text-kitsuden-subtle">{t("agentAccess.presetReplaces")}</p>
      </section>

      <!-- Broad scopes -->
      <section class="space-y-2">
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentAccess.broadScopes")}</h3>
        <div class="divide-y divide-kitsuden-border border border-kitsuden-border rounded-lg">
          {#each catalog.broad as b (b.scope)}
            <Checkbox
              class="flex items-start gap-3 p-3 hover:bg-kitsuden-card/50"
              checked={draft.includes(b.scope)}
              onchange={(e: Event) =>
                toggle(b.scope, (e.currentTarget as HTMLInputElement).checked)}
            >
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <code class="text-xs text-kitsuden-accent">{b.scope}</code>
                  {#if b.operations.length || b.datasets.length}
                    <span class="text-[11px] text-kitsuden-subtle"
                      >{t("agentAccess.opensCount", {
                        ops: b.operations.length,
                        ds: b.datasets.length,
                      })}</span
                    >
                  {/if}
                </div>
                <p class="text-sm text-kitsuden-text-dim">{broadDescription(b.scope)}</p>
                {#if b.operations.length}
                  <details class="mt-1">
                    <summary class="text-xs text-kitsuden-subtle cursor-pointer"
                      >{t("agentAccess.showOperations")}</summary
                    >
                    <div class="mt-1 flex flex-wrap gap-1">
                      {#each b.operations as o (o)}
                        <code
                          class="text-[11px] px-1.5 py-0.5 rounded-sm bg-kitsuden-border text-kitsuden-text-dim"
                          >{o}</code
                        >
                      {/each}
                    </div>
                  </details>
                {/if}
              </div>
            </Checkbox>
          {/each}
        </div>
      </section>
    {:else if mode === "fine"}
      <section class="space-y-3">
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentAccess.operationsByKon")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("agentAccess.denyExplained")}</p>
        {#each catalog.kons as k (k.konId)}
          <details
            class="border border-kitsuden-border rounded-lg"
            bind:open={
              () => deployed[k.konId] ?? catalog!.kons.length <= 2, (v) => (deployed[k.konId] = v)
            }
          >
            <summary
              class="px-3 py-2 cursor-pointer text-sm text-kitsuden-text flex items-center gap-2"
            >
              <span class="font-medium">{k.kon}</span>
              <code class="text-[11px] text-kitsuden-subtle">kon:{k.kon}:*</code>
              <span class="ml-auto text-xs text-kitsuden-subtle"
                >{t("agentAccess.selectedCount", {
                  n: k.operations.filter((o) => choiceOf(o.scope) !== "none").length,
                  total: k.operations.length,
                })}</span
              >
            </summary>
            <div class="divide-y divide-kitsuden-border/70">
              {#each k.operations as o (o.scope)}
                <div
                  class="flex flex-wrap items-center gap-2 px-3 py-2 min-w-0"
                  data-testid="op-{o.scope}"
                >
                  <Badge variant={o.write ? "warning" : "info"} class="font-mono shrink-0"
                    >{o.method}</Badge
                  >
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-kitsuden-text truncate">{o.summary}</div>
                    <code class="text-[11px] text-kitsuden-subtle break-all">{o.scope}</code>
                  </div>
                  {#if o.sensitive}
                    <Badge variant="error">{t("agentAccess.sensitive")}</Badge>
                  {/if}
                  {#if o.cost !== 1}
                    <span class="text-xs text-kitsuden-subtle"
                      >{t("agentAccess.cost", { n: o.cost })}</span
                    >
                  {/if}
                  <Select
                    size="sm"
                    width="auto"
                    options={CHOICES}
                    aria-label={t("agentAccess.permissionFor", { scope: o.scope })}
                    value={choiceOf(o.scope)}
                    onchange={(e: Event) =>
                      choose(o.scope, (e.currentTarget as HTMLSelectElement).value as Choice)}
                  />
                </div>
              {/each}
            </div>
          </details>
        {/each}
        {#if catalog.legacyKons.length}
          <p class="text-xs text-kitsuden-subtle">
            {t("agentAccess.legacyKons", { list: catalog.legacyKons.map((k) => k.kon).join(", ") })}
          </p>
        {/if}
      </section>

      <section class="space-y-2">
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentAccess.datasets")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("agentAccess.datasetsExplained")}</p>
        {#if catalog.datasets.length === 0}
          <p class="text-sm text-kitsuden-subtle">{t("agentAccess.noDatasets")}</p>
        {:else}
          <div class="min-w-0">
            <Table class="w-full text-sm">
              <TableHeader class="text-xs text-kitsuden-subtle">
                <TableRow>
                  <TableHead class="text-left px-3 py-2">{t("agentAccess.dataset")}</TableHead>
                  {#each ACTIONS as a (a)}<TableHead class="text-left px-3 py-2"
                      >{ACTION_NAME[a]()}</TableHead
                    >{/each}
                </TableRow>
              </TableHeader>
              <TableBody class="divide-y divide-kitsuden-border/70">
                {#each catalog.datasets as d (d.slug)}
                  <TableRow data-testid="ds-{d.slug}">
                    <TableCell class="px-3 py-2 min-w-0">
                      <div class="text-kitsuden-text">{d.name}</div>
                      <code class="text-[11px] text-kitsuden-subtle">{d.slug}</code>
                    </TableCell>
                    {#each ACTIONS as a (a)}
                      <TableCell class="px-3 py-2">
                        <Select
                          size="sm"
                          width="auto"
                          options={CHOICES}
                          aria-label={t("agentAccess.permissionFor", {
                            scope: `datasets:${d.slug}:${a}`,
                          })}
                          value={choiceOf(`datasets:${d.slug}:${a}`)}
                          onchange={(e: Event) =>
                            choose(
                              `datasets:${d.slug}:${a}`,
                              (e.currentTarget as HTMLSelectElement).value as Choice
                            )}
                        />
                      </TableCell>
                    {/each}
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          </div>
        {/if}
      </section>
    {:else}
      <section class="space-y-2">
        <label for="raw-scopes" class="block text-sm font-semibold text-kitsuden-text"
          >{t("agentAccess.rawScopes")}</label
        >
        <p class="text-xs text-kitsuden-subtle">{t("agentAccess.rawHelp")}</p>
        <Textarea id="raw-scopes" bind:value={rawValue} rows={10} mono />
      </section>
    {/if}

    <!-- What it can do (saved) -->
    <section class="space-y-3" data-testid="effective-access">
      <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentAccess.effectiveTitle")}</h3>
      <p class="text-xs text-kitsuden-subtle">{t("agentAccess.effectiveHelp")}</p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card class="p-3"
          ><div class="text-xs text-kitsuden-subtle">{t("agentAccess.statGranted")}</div>
          <div class="text-xl text-kitsuden-green">{summary.granted}</div></Card
        >
        <Card class="p-3"
          ><div class="text-xs text-kitsuden-subtle">{t("agentAccess.statDenied")}</div>
          <div class="text-xl text-kitsuden-danger">{summary.deniedMany}</div></Card
        >
        <Card class="p-3"
          ><div class="text-xs text-kitsuden-subtle">{t("agentAccess.statPolicy")}</div>
          <div class="text-xl text-kitsuden-amber">{summary.policy}</div></Card
        >
        <Card class="p-3"
          ><div class="text-xs text-kitsuden-subtle">{t("agentAccess.statTotal")}</div>
          <div class="text-xl text-kitsuden-text">{summary.total}</div></Card
        >
      </div>

      {#if access.broad.length}
        <div class="space-y-1">
          <h4 class="text-xs font-semibold text-kitsuden-text-dim">{t("agentAccess.broadHeld")}</h4>
          {#each access.broad as b (b.scope)}
            <div class="flex flex-wrap items-baseline gap-2 text-sm">
              <Check size={14} class="text-kitsuden-green shrink-0" />
              <code class="text-xs text-kitsuden-accent">{b.scope}</code>
              <span class="text-kitsuden-text-dim"
                >{b.known ? broadDescription(b.scope) : t("agentAccess.unknownScope")}</span
              >
            </div>
          {/each}
        </div>
      {/if}
      {#if access.denies.length}
        <div class="space-y-1">
          <h4 class="text-xs font-semibold text-kitsuden-text-dim">
            {t("agentAccess.deniesHeld")}
          </h4>
          {#each access.denies as d (d)}
            <div class="flex items-center gap-2 text-sm">
              <Ban size={14} class="text-kitsuden-danger shrink-0" /><code
                class="text-xs text-kitsuden-danger">{d}</code
              >
            </div>
          {/each}
        </div>
      {/if}

      {#if opsWithPermission.length}
        <div class="space-y-2">
          {#each byKon as g (g.kon)}
            <details
              class="border border-kitsuden-border rounded-lg"
              data-testid="effective-{g.kon}"
            >
              <summary
                class="px-3 py-2 cursor-pointer text-sm text-kitsuden-text flex flex-wrap items-center gap-2"
              >
                <span class="font-medium">{g.kon}</span>
                <Badge variant={STATUS.granted.kind}
                  >{t("agentAccess.groupGranted", { n: g.granted })}</Badge
                >
                {#if g.deniedMany}
                  <Badge variant={STATUS.denied.kind}
                    >{t("agentAccess.groupDenied", { n: g.deniedMany })}</Badge
                  >
                {/if}
              </summary>
              <div class="divide-y divide-kitsuden-border/70 border-t border-kitsuden-border">
                {#each g.ops as o (o.scope)}
                  <div class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm min-w-0">
                    <Badge variant={STATUS[o.state].kind}>{STATUS[o.state].text()}</Badge>
                    <span class="font-mono text-[11px] text-kitsuden-subtle">{o.method}</span>
                    <span class="text-kitsuden-text truncate min-w-0">{o.path}</span>
                    {#if o.by}<code class="ml-auto text-[11px] text-kitsuden-subtle"
                        >{t("agentAccess.by", { scope: o.by })}</code
                      >{/if}
                  </div>
                {/each}
              </div>
            </details>
          {/each}
        </div>
      {:else}
        <p class="text-sm text-kitsuden-subtle">{t("agentAccess.noOperationGrants")}</p>
      {/if}

      {#if access.datasets.length}
        <div class="min-w-0">
          <Table class="w-full text-sm">
            <TableHeader class="text-xs text-kitsuden-subtle">
              <TableRow>
                <TableHead class="text-left px-3 py-2">{t("agentAccess.dataset")}</TableHead>
                {#each ACTIONS as a (a)}<TableHead class="text-left px-3 py-2"
                    >{ACTION_NAME[a]()}</TableHead
                  >{/each}
              </TableRow>
            </TableHeader>
            <TableBody class="divide-y divide-kitsuden-border/70">
              {#each access.datasets as d (d.slug)}
                <TableRow>
                  <TableCell class="px-3 py-2"
                    ><code class="text-xs text-kitsuden-text">{d.slug}</code></TableCell
                  >
                  {#each ACTIONS as a (a)}
                    <TableCell class="px-3 py-2">
                      <Badge variant={STATUS[d[a].state].kind} title={d[a].by ?? ""}
                        >{STATUS[d[a].state].text()}</Badge
                      >
                    </TableCell>
                  {/each}
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      {/if}
    </section>

    <SaveBar
      dirty={changed}
      {saving}
      disableWhenClean
      saveLabel={t("agentAccess.save")}
      dirtyText={t("agentAccess.unsaved")}
      cancelLabel={t("agentAccess.discard")}
      onSave={save}
      onCancel={changed ? undo : undefined}
    />
  {/if}
</div>
