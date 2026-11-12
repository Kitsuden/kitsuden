<!--
  External MCP servers (docs/agents/external-mcp.md): the registry, and the
  review of each server's tools. A tool that is new, changed or removed since
  it was approved needs a person to look at its description and schema and
  approve that exact fingerprint. An approved tool shows the name agents see
  and the scope they need (lib/external-mcp-bridge.ts in the API).
-->
<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw, ServerCog, ShieldCheck, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    EmptyState,
    Field,
    Input,
    Spinner,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    toast,
  } from "$lib/tallao";

  import {
    approveTool,
    createServer,
    deleteServer,
    listServers,
    listTools,
    refreshServer,
    setEnabled,
    type McpServer,
    type McpTool,
  } from "$lib/services/mcp-servers";

  let servers = $state<McpServer[]>([]);
  let tools = $state<Record<string, McpTool[]>>({});
  let open = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let form = $state({ name: "", url: "", authHeaderName: "", authHeaderValue: "" });

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    try {
      servers = await listServers();
      if (open) tools[open] = await listTools(open);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    busy = key;
    try {
      await fn();
      if (done) toast.success(done);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const input = {
      name: form.name.trim(),
      url: form.url.trim(),
      ...(form.authHeaderName && form.authHeaderValue
        ? { authHeaderName: form.authHeaderName.trim(), authHeaderValue: form.authHeaderValue }
        : {}),
    };
    await run(
      "add",
      async () => {
        await createServer(input);
        form = { name: "", url: "", authHeaderName: "", authHeaderValue: "" };
      },
      t("mcpServers.added")
    );
  }

  async function refresh(s: McpServer) {
    await run(`refresh:${s.id}`, async () => {
      const r = await refreshServer(s.id);
      if (!r.ok) throw new Error(r.error ?? t("mcpServers.refreshFailed"));
      open = s.id;
      toast.success(t("mcpServers.refreshed", { tools: r.tools, review: r.needsReview.length }));
    });
  }

  async function toggle(s: McpServer) {
    if (open === s.id) {
      open = null;
      return;
    }
    open = s.id;
    await run(`tools:${s.id}`, async () => {
      tools[s.id] = await listTools(s.id);
    });
  }

  async function remove(s: McpServer) {
    if (!(await confirmDialog(t("mcpServers.confirmDelete", { name: s.name })))) return;
    await run(`delete:${s.id}`, () => deleteServer(s.id), t("mcpServers.deleted"));
  }

  async function approve(s: McpServer, tool: McpTool) {
    await run(
      `approve:${s.id}:${tool.name}`,
      () => approveTool(s.id, tool.name, tool.fingerprint),
      t("mcpServers.approved")
    );
  }

  const date = (f: string | null) =>
    f ? new Date(f).toLocaleString(localeFormat()) : t("mcpServers.never");
  const short = (fp: string | null) => (fp ? fp.replace(/^sha256:/, "").slice(0, 12) : "—");
  const changeLabel = (c: McpTool["change"]) =>
    c === "new"
      ? t("mcpServers.changeNew")
      : c === "changed"
        ? t("mcpServers.changeChanged")
        : c === "removed"
          ? t("mcpServers.changeRemoved")
          : "";
</script>

<div class="space-y-6" data-testid="mcp-servers">
  <p class="text-sm text-kitsuden-text-dim">{t("mcpServers.help")}</p>

  <Card>
    <CardContent>
      <form class="grid gap-3 md:grid-cols-5 items-end" onsubmit={add}>
        <Field label={t("mcpServers.name")} required>
          <Input bind:value={form.name} required />
        </Field>
        <Field label={t("mcpServers.url")} required class="md:col-span-2">
          <Input type="url" bind:value={form.url} required />
        </Field>
        <Field label={t("mcpServers.authHeaderName")}>
          <Input bind:value={form.authHeaderName} />
        </Field>
        <Field label={t("mcpServers.authHeaderValue")}>
          <Input type="password" autocomplete="off" bind:value={form.authHeaderValue} />
        </Field>
        <div class="md:col-span-5 flex justify-end">
          <Button type="submit" loading={busy === "add"}>{t("mcpServers.add")}</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  {#if loading && servers.length === 0}
    <div class="flex items-center justify-center h-24">
      <Spinner />
    </div>
  {:else if error}
    <Alert variant="error">{error}</Alert>
  {:else if servers.length === 0}
    <EmptyState size="sm" title={t("mcpServers.empty")} data-testid="mcp-servers-empty" />
  {:else}
    <div class="space-y-3">
      {#each servers as s (s.id)}
        <div data-testid="mcp-server-row">
          <Card class="p-3">
            <div class="flex flex-wrap items-center gap-3 justify-between">
              <div class="min-w-0">
                <Button
                  variant="ghost"
                  size="sm"
                  class="-ml-2 font-medium"
                  aria-expanded={open === s.id}
                  onclick={() => toggle(s)}>{s.name}</Button
                >
                <span class="block text-xs text-kitsuden-subtle break-all">{s.url}</span>
                <span class="block text-xs text-kitsuden-subtle">
                  {t("mcpServers.summary", {
                    tools: s.tools,
                    review: s.needsReview,
                    date: date(s.lastRefreshedAt),
                  })}
                </span>
                {#if s.lastError}<span class="block text-xs text-kitsuden-danger"
                    >{s.lastError}</span
                  >{/if}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                {#if s.needsReview > 0}
                  <Badge variant="warning"
                    >{t("mcpServers.needsReview", { count: s.needsReview })}</Badge
                  >
                {/if}
                <Switch
                  size="sm"
                  bind:checked={
                    () => s.enabled, () => run(`enable:${s.id}`, () => setEnabled(s.id, !s.enabled))
                  }
                  label={t("mcpServers.enabled")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === `refresh:${s.id}`}
                  onclick={() => refresh(s)}
                >
                  <RefreshCw size={14} aria-hidden="true" />{t("mcpServers.refresh")}
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  loading={busy === `delete:${s.id}`}
                  onclick={() => remove(s)}
                >
                  <Trash2 size={14} aria-hidden="true" />{t("mcpServers.delete")}
                </Button>
              </div>
            </div>

            {#if open === s.id}
              {#if (tools[s.id] ?? []).length === 0}
                <EmptyState
                  size="sm"
                  icon={false}
                  level={null}
                  class="mt-3"
                  title={t("mcpServers.noTools")}
                />
              {:else}
                <div class="mt-3 min-w-0">
                  <Table density="compact">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("mcpServers.tool")}</TableHead>
                        <TableHead>{t("mcpServers.status")}</TableHead>
                        <TableHead>{t("mcpServers.fingerprint")}</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {#each tools[s.id] ?? [] as tool (tool.name)}
                        <TableRow data-testid="mcp-tool-row">
                          <TableCell>
                            {tool.name}
                            <details class="text-xs text-kitsuden-text-dim">
                              <summary class="cursor-pointer">{t("mcpServers.details")}</summary>
                              <p class="whitespace-pre-wrap wrap-break-word mt-1">
                                {tool.description ?? ""}
                              </p>
                              <pre
                                class="mt-1 overflow-x-auto text-kitsuden-subtle">{JSON.stringify(
                                  tool.inputSchema,
                                  null,
                                  2
                                )}</pre>
                            </details>
                          </TableCell>
                          <TableCell>
                            {#if tool.status === "approved"}
                              <Badge variant="success">{t("mcpServers.statusApproved")}</Badge>
                              {#if tool.agentTool}
                                <span
                                  class="block text-xs text-kitsuden-text-dim"
                                  data-testid="mcp-tool-agent"
                                >
                                  {t("mcpServers.agentName")}
                                  <code class="text-kitsuden-text">{tool.agentTool.name}</code>
                                  · {t("mcpServers.agentScope")}
                                  <code class="text-kitsuden-text">{tool.agentTool.scope}</code>
                                </span>
                                {#if !tool.agentTool.offered}
                                  <span class="block text-xs text-kitsuden-amber"
                                    >{t("mcpServers.notOffered")}</span
                                  >
                                {/if}
                              {/if}
                            {:else}
                              <Badge variant="warning"
                                >{t("mcpServers.statusReview")} · {changeLabel(tool.change)}</Badge
                              >
                            {/if}
                          </TableCell>
                          <TableCell>
                            <code class="text-xs text-kitsuden-text">{short(tool.fingerprint)}</code
                            >
                            {#if tool.approvedFingerprint && tool.approvedFingerprint !== tool.fingerprint}
                              <span class="block text-xs text-kitsuden-subtle"
                                >{t("mcpServers.approvedWas", {
                                  fp: short(tool.approvedFingerprint),
                                })}</span
                              >
                            {/if}
                          </TableCell>
                          <TableCell class="text-right">
                            {#if tool.status === "needs_review"}
                              <Button
                                size="sm"
                                loading={busy === `approve:${s.id}:${tool.name}`}
                                onclick={() => approve(s, tool)}
                              >
                                <ShieldCheck size={14} aria-hidden="true" />{tool.change ===
                                "removed"
                                  ? t("mcpServers.acknowledge")
                                  : t("mcpServers.approve")}
                              </Button>
                            {/if}
                          </TableCell>
                        </TableRow>
                      {/each}
                    </TableBody>
                  </Table>
                </div>
              {/if}
            {/if}
          </Card>
        </div>
      {/each}
    </div>
  {/if}
</div>
