<!--
  An agent's keys: create with expiry, rotate without downtime (the old
  one stays valid during the grace period), revoke instantly and see the last use.
  The secret is shown only once, with TokenDisplay.
-->
<script lang="ts">
  import {
    Button,
    Dialog,
    Skeleton,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import { KeyRound, RefreshCw, Ban, Plus } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "$lib/tallao";

  import TokenDisplay from "$lib/components/agents/TokenDisplay.svelte";
  import {
    createAgentKey,
    listAgentKeys,
    revokeAgentKey,
    rotateAgentKey,
  } from "$lib/services/agents";
  import type { AgentApiKey } from "$lib/types/agents";

  interface Props {
    agentId: string;
  }
  const { agentId }: Props = $props();

  let keys = $state<AgentApiKey[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let secret = $state<string | undefined>();

  let creating = $state(false);
  let name = $state("");
  let expiry = $state<string>("90");

  let rotating = $state<AgentApiKey | null>(null);
  let grace = $state<string>("24");
  let revoking = $state<AgentApiKey | null>(null);
  let busy = $state(false);

  onMount(load);

  async function load() {
    try {
      loading = true;
      error = null;
      keys = await listAgentKeys(agentId);
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentKeys.errorLoading");
    } finally {
      loading = false;
    }
  }

  const days = (v: string): number | null => (v === "never" ? null : Number(v));

  async function create() {
    try {
      busy = true;
      const r = await createAgentKey(agentId, {
        name: name || undefined,
        expiresInDays: days(expiry),
      });
      secret = r.apiKey;
      creating = false;
      name = "";
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentKeys.errorCreating"));
    } finally {
      busy = false;
    }
  }

  async function rotate() {
    if (!rotating) return;
    try {
      busy = true;
      const r = await rotateAgentKey(agentId, rotating.id, { graceHours: Number(grace) });
      secret = r.apiKey;
      rotating = null;
      await load();
      toast.success(t("agentKeys.rotated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentKeys.errorRotating"));
    } finally {
      busy = false;
    }
  }

  async function revoke() {
    if (!revoking) return;
    try {
      busy = true;
      await revokeAgentKey(agentId, revoking.id);
      revoking = null;
      await load();
      toast.success(t("agentKeys.revoked"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("agentKeys.errorRevoking"));
    } finally {
      busy = false;
    }
  }

  const date = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");

  const STATUS: Record<AgentApiKey["status"], { text: () => string; kind: string }> = {
    active: {
      text: () => t("agentKeys.statusActive"),
      kind: "bg-kitsuden-green/15 text-kitsuden-green",
    },
    expiring: {
      text: () => t("agentKeys.statusExpiring"),
      kind: "bg-kitsuden-amber/15 text-kitsuden-amber",
    },
    expired: {
      text: () => t("agentKeys.statusExpired"),
      kind: "bg-kitsuden-muted/40 text-kitsuden-text-dim",
    },
    revoked: {
      text: () => t("agentKeys.statusRevoked"),
      kind: "bg-kitsuden-danger/15 text-kitsuden-danger",
    },
  };
  const alive = (k: AgentApiKey) => k.status === "active" || k.status === "expiring";
</script>

<div class="space-y-4" data-testid="agent-keys">
  <div class="flex flex-wrap items-center gap-3">
    <div class="min-w-0">
      <h3 class="text-sm font-semibold text-kitsuden-text">{t("agentKeys.title")}</h3>
      <p class="text-xs text-kitsuden-subtle">{t("agentKeys.help")}</p>
    </div>
    <div class="flex-1"></div>
    <Button variant="primary" size="sm" onclick={() => (creating = true)}>
      <Plus size={14} class="mr-1" />{t("agentKeys.newKey")}
    </Button>
  </div>

  {#if loading}
    <Skeleton lines={3} />
  {:else if error}
    <div
      class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
    >
      {error}
    </div>
  {:else if keys.length === 0}
    <p class="text-sm text-kitsuden-subtle">{t("agentKeys.none")}</p>
  {:else}
    <div class="overflow-x-auto border border-kitsuden-border rounded-lg">
      <Table class="w-full text-sm">
        <TableHeader class="text-xs text-kitsuden-subtle">
          <TableRow>
            <TableHead class="text-left px-3 py-2">{t("agentKeys.key")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("agentKeys.status")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("agentKeys.created")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("agentKeys.lastUsed")}</TableHead>
            <TableHead class="text-left px-3 py-2">{t("agentKeys.expires")}</TableHead>
            <TableHead class="px-3 py-2"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody class="divide-y divide-kitsuden-border/70">
          {#each keys as k (k.id)}
            <TableRow data-testid="key-row">
              <TableCell class="px-3 py-2 min-w-0">
                <div class="flex items-center gap-2">
                  <KeyRound size={14} class="text-kitsuden-subtle shrink-0" />
                  <span class="text-kitsuden-text">{k.name || t("agentKeys.unnamed")}</span>
                </div>
                <code class="text-[11px] text-kitsuden-subtle break-all">{k.prefix}</code>
                {#if k.rotatedFrom}
                  <div class="text-[11px] text-kitsuden-subtle">
                    {t("agentKeys.rotatedFromNote")}
                  </div>
                {/if}
              </TableCell>
              <TableCell class="px-3 py-2">
                <span class="text-[11px] px-1.5 py-0.5 rounded-sm {STATUS[k.status].kind}"
                  >{STATUS[k.status].text()}</span
                >
              </TableCell>
              <TableCell class="px-3 py-2 text-kitsuden-text-dim whitespace-nowrap"
                >{date(k.createdAt)}</TableCell
              >
              <TableCell class="px-3 py-2 text-kitsuden-text-dim whitespace-nowrap"
                >{k.lastUsedAt ? date(k.lastUsedAt) : t("agentKeys.never")}</TableCell
              >
              <TableCell class="px-3 py-2 text-kitsuden-text-dim whitespace-nowrap">
                {k.revokedAt
                  ? date(k.revokedAt)
                  : k.expiresAt
                    ? date(k.expiresAt)
                    : t("agentKeys.noExpiry")}
              </TableCell>
              <TableCell class="px-3 py-2">
                {#if alive(k)}
                  <div class="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onclick={() => (rotating = k)}>
                      <RefreshCw size={14} class="mr-1" />{t("agentKeys.rotate")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="text-kitsuden-danger hover:text-kitsuden-danger"
                      onclick={() => (revoking = k)}
                    >
                      <Ban size={14} class="mr-1" />{t("agentKeys.revoke")}
                    </Button>
                  </div>
                {/if}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>

<Dialog
  open={creating}
  title={t("agentKeys.newKey")}
  description={t("agentKeys.newKeyHelp")}
  onClose={() => (creating = false)}
>
  <form
    class="space-y-4"
    onsubmit={(e) => {
      e.preventDefault();
      create();
    }}
  >
    <div>
      <label for="key-name" class="block text-sm font-medium text-kitsuden-text mb-1.5"
        >{t("agentKeys.name")}</label
      >
      <input
        id="key-name"
        bind:value={name}
        placeholder={t("agentKeys.namePlaceholder")}
        class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
      />
    </div>
    <div>
      <label for="key-expiry" class="block text-sm font-medium text-kitsuden-text mb-1.5"
        >{t("agentKeys.expiry")}</label
      >
      <select
        id="key-expiry"
        bind:value={expiry}
        class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
      >
        <option value="30">{t("agentKeys.days", { n: 30 })}</option>
        <option value="90">{t("agentKeys.days", { n: 90 })}</option>
        <option value="365">{t("agentKeys.days", { n: 365 })}</option>
        <option value="never">{t("agentKeys.noExpiry")}</option>
      </select>
    </div>
    <div class="flex justify-end gap-3 pt-2">
      <Button type="button" variant="secondary" onclick={() => (creating = false)}
        >{t("common.cancel")}</Button
      >
      <Button type="submit" variant="primary" loading={busy}>{t("agentKeys.create")}</Button>
    </div>
  </form>
</Dialog>

<Dialog
  open={!!rotating}
  title={t("agentKeys.rotateTitle")}
  description={t("agentKeys.rotateHelp")}
  onClose={() => (rotating = null)}
>
  <div class="space-y-4">
    <div>
      <label for="key-grace" class="block text-sm font-medium text-kitsuden-text mb-1.5"
        >{t("agentKeys.grace")}</label
      >
      <select
        id="key-grace"
        bind:value={grace}
        class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
      >
        <option value="0">{t("agentKeys.graceNow")}</option>
        <option value="1">{t("agentKeys.hours", { n: 1 })}</option>
        <option value="24">{t("agentKeys.hours", { n: 24 })}</option>
        <option value="72">{t("agentKeys.hours", { n: 72 })}</option>
        <option value="168">{t("agentKeys.hours", { n: 168 })}</option>
      </select>
    </div>
    <div class="flex justify-end gap-3">
      <Button variant="secondary" onclick={() => (rotating = null)}>{t("common.cancel")}</Button>
      <Button variant="primary" loading={busy} onclick={rotate}>{t("agentKeys.rotate")}</Button>
    </div>
  </div>
</Dialog>

<Dialog
  open={!!revoking}
  title={t("agentKeys.revokeTitle")}
  description={t("agentKeys.revokeHelp")}
  size="sm"
  onClose={() => (revoking = null)}
>
  <div class="flex justify-end gap-3">
    <Button variant="secondary" onclick={() => (revoking = null)}>{t("common.cancel")}</Button>
    <Button variant="danger" loading={busy} onclick={revoke}>{t("agentKeys.revoke")}</Button>
  </div>
</Dialog>

{#if secret}
  {#key secret}
    <TokenDisplay token={secret} />
  {/key}
{/if}
