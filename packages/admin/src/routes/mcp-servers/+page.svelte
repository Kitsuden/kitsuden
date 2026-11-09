<!--
  External MCP servers (docs/agents/external-mcp.md): the registry, and the
  review of each server's tools. A tool that is new, changed or removed since
  it was approved needs a person to look at its description and schema and
  approve that exact fingerprint. An approved tool shows the name agents see
  and the scope they need (lib/external-mcp-bridge.ts in the API).
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { RefreshCw, ServerCog, ShieldCheck, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import Button from "$lib/components/ui/Button.svelte";
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
    if (!confirm(t("mcpServers.confirmDelete", { name: s.name }))) return;
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

<div class="p-6 space-y-6" data-testid="mcp-servers">
  <div class="flex items-start gap-3">
    <div class="p-2 rounded-lg bg-indigo-500/10 text-indigo-300"><ServerCog size={20} /></div>
    <div>
      <h1 class="text-xl font-semibold text-zinc-100">{t("mcpServers.title")}</h1>
      <p class="text-sm text-zinc-400">{t("mcpServers.help")}</p>
    </div>
  </div>

  <form class="grid gap-2 md:grid-cols-5 items-end" onsubmit={add}>
    <label class="text-xs text-zinc-400"
      >{t("mcpServers.name")}
      <input
        class="mt-1 w-full rounded-sm bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm text-zinc-100"
        bind:value={form.name}
        required
      />
    </label>
    <label class="text-xs text-zinc-400 md:col-span-2"
      >{t("mcpServers.url")}
      <input
        class="mt-1 w-full rounded-sm bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm text-zinc-100"
        type="url"
        bind:value={form.url}
        required
      />
    </label>
    <label class="text-xs text-zinc-400"
      >{t("mcpServers.authHeaderName")}
      <input
        class="mt-1 w-full rounded-sm bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm text-zinc-100"
        bind:value={form.authHeaderName}
      />
    </label>
    <label class="text-xs text-zinc-400"
      >{t("mcpServers.authHeaderValue")}
      <input
        class="mt-1 w-full rounded-sm bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm text-zinc-100"
        type="password"
        autocomplete="off"
        bind:value={form.authHeaderValue}
      />
    </label>
    <div class="md:col-span-5">
      <Button type="submit" size="sm" loading={busy === "add"}>{t("mcpServers.add")}</Button>
    </div>
  </form>

  {#if loading && servers.length === 0}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if servers.length === 0}
    <p class="text-sm text-zinc-500" data-testid="mcp-servers-empty">{t("mcpServers.empty")}</p>
  {:else}
    <div class="space-y-3">
      {#each servers as s (s.id)}
        <div class="rounded-lg border border-zinc-800 p-3" data-testid="mcp-server-row">
          <div class="flex flex-wrap items-center gap-3 justify-between">
            <div>
              <button class="text-zinc-100 font-medium hover:underline" onclick={() => toggle(s)}
                >{s.name}</button
              >
              <span class="block text-xs text-zinc-500 break-all">{s.url}</span>
              <span class="block text-xs text-zinc-500">
                {t("mcpServers.summary", {
                  tools: s.tools,
                  review: s.needsReview,
                  date: date(s.lastRefreshedAt),
                })}
              </span>
              {#if s.lastError}<span class="block text-xs text-red-400">{s.lastError}</span>{/if}
            </div>
            <div class="flex items-center gap-2">
              {#if s.needsReview > 0}
                <span class="text-xs rounded-sm px-2 py-0.5 bg-amber-500/10 text-amber-300"
                  >{t("mcpServers.needsReview", { count: s.needsReview })}</span
                >
              {/if}
              <label class="flex items-center gap-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onchange={() => run(`enable:${s.id}`, () => setEnabled(s.id, !s.enabled))}
                />
                {t("mcpServers.enabled")}
              </label>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === `refresh:${s.id}`}
                onclick={() => refresh(s)}
              >
                <RefreshCw size={14} class="mr-1" />{t("mcpServers.refresh")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-red-400"
                loading={busy === `delete:${s.id}`}
                onclick={() => remove(s)}
              >
                <Trash2 size={14} class="mr-1" />{t("mcpServers.delete")}
              </Button>
            </div>
          </div>

          {#if open === s.id}
            {#if (tools[s.id] ?? []).length === 0}
              <p class="mt-3 text-sm text-zinc-500">{t("mcpServers.noTools")}</p>
            {:else}
              <table class="mt-3 w-full text-sm">
                <thead class="text-left text-xs text-zinc-500">
                  <tr>
                    <th class="py-2 pr-3">{t("mcpServers.tool")}</th>
                    <th class="py-2 pr-3">{t("mcpServers.status")}</th>
                    <th class="py-2 pr-3">{t("mcpServers.fingerprint")}</th>
                    <th class="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each tools[s.id] ?? [] as tool (tool.name)}
                    <tr class="border-t border-zinc-800 align-top" data-testid="mcp-tool-row">
                      <td class="py-2 pr-3 text-zinc-100">
                        {tool.name}
                        <details class="text-xs text-zinc-400">
                          <summary class="cursor-pointer">{t("mcpServers.details")}</summary>
                          <p class="whitespace-pre-wrap wrap-break-word mt-1">
                            {tool.description ?? ""}
                          </p>
                          <pre class="mt-1 overflow-x-auto text-zinc-500">{JSON.stringify(
                              tool.inputSchema,
                              null,
                              2
                            )}</pre>
                        </details>
                      </td>
                      <td class="py-2 pr-3">
                        {#if tool.status === "approved"}
                          <span class="text-xs text-emerald-300"
                            >{t("mcpServers.statusApproved")}</span
                          >
                          {#if tool.agentTool}
                            <span class="block text-xs text-zinc-400" data-testid="mcp-tool-agent">
                              {t("mcpServers.agentName")}
                              <code class="text-zinc-300">{tool.agentTool.name}</code>
                              · {t("mcpServers.agentScope")}
                              <code class="text-zinc-300">{tool.agentTool.scope}</code>
                            </span>
                            {#if !tool.agentTool.offered}
                              <span class="block text-xs text-amber-300"
                                >{t("mcpServers.notOffered")}</span
                              >
                            {/if}
                          {/if}
                        {:else}
                          <span class="text-xs text-amber-300"
                            >{t("mcpServers.statusReview")} · {changeLabel(tool.change)}</span
                          >
                        {/if}
                      </td>
                      <td class="py-2 pr-3">
                        <code class="text-xs text-zinc-300">{short(tool.fingerprint)}</code>
                        {#if tool.approvedFingerprint && tool.approvedFingerprint !== tool.fingerprint}
                          <span class="block text-xs text-zinc-500"
                            >{t("mcpServers.approvedWas", {
                              fp: short(tool.approvedFingerprint),
                            })}</span
                          >
                        {/if}
                      </td>
                      <td class="py-2 text-right">
                        {#if tool.status === "needs_review"}
                          <Button
                            size="sm"
                            loading={busy === `approve:${s.id}:${tool.name}`}
                            onclick={() => approve(s, tool)}
                          >
                            <ShieldCheck size={14} class="mr-1" />{tool.change === "removed"
                              ? t("mcpServers.acknowledge")
                              : t("mcpServers.approve")}
                          </Button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
