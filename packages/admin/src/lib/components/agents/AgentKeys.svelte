<!--
  An agent's keys: create with expiry, rotate without downtime (the old
  one stays valid during the grace period), revoke instantly and see the last use.
  The secret is shown only once, with TokenDisplay.
-->
<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    Skeleton,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { formatDateTime } from "$lib/utils";
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

  const date = formatDateTime;

  const STATUS: Record<
    AgentApiKey["status"],
    { text: () => string; kind: "success" | "warning" | "default" | "error" }
  > = {
    active: {
      text: () => t("agentKeys.statusActive"),
      kind: "success",
    },
    expiring: {
      text: () => t("agentKeys.statusExpiring"),
      kind: "warning",
    },
    expired: {
      text: () => t("agentKeys.statusExpired"),
      kind: "default",
    },
    revoked: {
      text: () => t("agentKeys.statusRevoked"),
      kind: "error",
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
    <Alert variant="error">{error}</Alert>
  {:else if keys.length === 0}
    <EmptyState
      size="sm"
      title={t("agentKeys.none")}
      actionLabel={t("agentKeys.newKey")}
      onAction={() => (creating = true)}
    />
  {:else}
    <div class="min-w-0">
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
                <Badge variant={STATUS[k.status].kind}>{STATUS[k.status].text()}</Badge>
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
                    <Button variant="danger-ghost" size="sm" onclick={() => (revoking = k)}>
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
    <Field label={t("agentKeys.name")}>
      <Input id="key-name" bind:value={name} placeholder={t("agentKeys.namePlaceholder")} />
    </Field>
    <Field label={t("agentKeys.expiry")}>
      <Select
        id="key-expiry"
        bind:value={expiry}
        options={[
          { value: "30", label: t("agentKeys.days", { n: 30 }) },
          { value: "90", label: t("agentKeys.days", { n: 90 }) },
          { value: "365", label: t("agentKeys.days", { n: 365 }) },
          { value: "never", label: t("agentKeys.noExpiry") },
        ]}
      />
    </Field>
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
    <Field label={t("agentKeys.grace")}>
      <Select
        id="key-grace"
        bind:value={grace}
        options={[
          { value: "0", label: t("agentKeys.graceNow") },
          { value: "1", label: t("agentKeys.hours", { n: 1 }) },
          { value: "24", label: t("agentKeys.hours", { n: 24 }) },
          { value: "72", label: t("agentKeys.hours", { n: 72 }) },
          { value: "168", label: t("agentKeys.hours", { n: 168 }) },
        ]}
      />
    </Field>
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
