<!--
  The API console of one kon: pick an operation (or a tag) and read or try it with RapiDoc's
  <rapi-doc-mini>. Developer oversight, not a work screen.

  RapiDoc never fetches anything itself: the panel fetches the kon's document, neutralises it
  (lib/api-console/spec.ts: no raw HTML in descriptions, no external $ref, this API as the only
  server, no security schemes) and passes the object to `loadSpec()`. Its script is loaded the
  first time a console opens, pinned with SRI (lib/api-console/rapidoc.ts). Requests carry the
  panel session cookie; the console never asks for a token.
-->
<script lang="ts">
  import { api, type ApiError } from "$lib/api";
  import { loadRapiDoc, RAPIDOC_VERSION } from "$lib/api-console/rapidoc";
  import {
    listOperations,
    listTags,
    parseSelection,
    prepareConsoleSpec,
    selectionValue,
    type ConsoleOperation,
  } from "$lib/api-console/spec";
  import { t } from "$lib/i18n";
  import { Alert, EmptyState, Field, Select, Skeleton } from "$lib/tallao";
  import { currentTheme } from "$lib/theme.svelte";

  const { konId }: { konId: string } = $props();

  /** "" in the image (nginx proxies /api); the API's origin in development. */
  const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

  /**
   * Fixed attributes. `allow-spec-*` belong to <rapi-doc>, not to the mini in this version:
   * set anyway, so a later version that reads them cannot start loading URLs or files.
   */
  const ATTRIBUTES: Record<string, string> = {
    layout: "column",
    "paths-expanded": "true",
    "allow-try": "true",
    "persist-auth": "false",
    "mock-server": "false",
    "allow-spec-url-load": "false",
    "allow-spec-file-load": "false",
    "fetch-credentials": API_BASE ? "include" : "same-origin",
  };

  type MiniElement = HTMLElement & { loadSpec(spec: unknown): Promise<void> };

  let spec = $state.raw<unknown>(null);
  let operations = $state.raw<ConsoleOperation[]>([]);
  let selected = $state("");
  let status = $state<"loading" | "ready" | "error">("loading");
  let errorText = $state("");
  let host = $state<HTMLDivElement>();

  const groups = $derived.by(() => {
    const byTag = new Map<string, ConsoleOperation[]>();
    for (const op of operations) {
      const tag = op.tags[0] ?? "";
      byTag.set(tag, [...(byTag.get(tag) ?? []), op]);
    }
    return [...byTag].map(([tag, ops]) => ({ tag, ops }));
  });
  const tagged = $derived(new Set(listTags(operations)));

  const opValue = (op: ConsoleOperation) =>
    selectionValue({ kind: "operation", method: op.method, path: op.path });
  const opLabel = (op: ConsoleOperation) =>
    `${op.method.toUpperCase()} ${op.path}${op.summary ? ` · ${op.summary}` : ""}`;

  async function load(kon: string) {
    status = "loading";
    errorText = "";
    const slug = encodeURIComponent(kon.replace(/^kon-/, ""));
    try {
      const [doc] = await Promise.all([
        api.get<unknown>(`/api/docs/${slug}/openapi.json`),
        loadRapiDoc(API_BASE).catch(() => {
          throw new Error(t("apiConsole.scriptFailed"));
        }),
      ]);
      spec = doc;
      operations = listOperations(doc);
      selected = operations[0] ? opValue(operations[0]) : "";
      status = "ready";
    } catch (e) {
      // 404: a kon without a document, or /api/docs switched off (ENABLE_SWAGGER).
      errorText =
        (e as ApiError)?.status === 404
          ? t("apiConsole.notDocumented")
          : e instanceof Error
            ? e.message
            : String(e);
      status = "error";
    }
  }

  $effect(() => {
    void load(konId);
  });

  /** The panel's accent as a hex colour for RapiDoc's `theme`, or "" if it cannot be read. */
  function accentHex(): string {
    const triplet = getComputedStyle(document.documentElement)
      .getPropertyValue("--kitsuden-accent")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (triplet.length !== 3 || triplet.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return "";
    }
    return `#${triplet.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  // A fresh element per selection: no stale load can land on the new one.
  $effect(() => {
    const target = host;
    const doc = spec;
    const selection = parseSelection(selected);
    const scheme = currentTheme() === "latte" ? "light" : "dark";
    if (!target || status !== "ready" || !doc || !selection) return;

    const mini = document.createElement("rapi-doc-mini") as MiniElement;
    for (const [name, value] of Object.entries(ATTRIBUTES)) mini.setAttribute(name, value);
    mini.setAttribute("color-scheme", scheme);
    const accent = accentHex();
    if (accent) mini.setAttribute("theme", accent);
    target.replaceChildren(mini);
    void mini.loadSpec(
      prepareConsoleSpec(doc, { serverUrl: `${API_BASE || location.origin}/api`, selection })
    );
    return () => mini.remove();
  });
</script>

<div class="api-console">
  {#if status === "loading"}
    <div role="status" aria-busy="true">
      <span class="sr-only">{t("apiConsole.loading")}</span>
      <Skeleton lines={6} />
    </div>
  {:else if status === "error"}
    <EmptyState
      variant="error"
      title={t("apiConsole.loadFailed")}
      description={errorText}
      onRetry={() => load(konId)}
      size="sm"
    />
  {:else if operations.length === 0}
    <EmptyState title={t("apiConsole.noOperations")} size="sm" />
  {:else}
    <Alert variant="warning">{t("apiConsole.sessionNotice")}</Alert>

    <Field label={t("apiConsole.operation")}>
      <Select bind:value={selected}>
        {#each groups as group (group.tag)}
          <optgroup label={group.tag || t("apiConsole.untagged")}>
            {#if group.tag && tagged.has(group.tag)}
              <option value={selectionValue({ kind: "tag", tag: group.tag })}>
                {t("apiConsole.allInTag", { tag: group.tag })}
              </option>
            {/if}
            {#each group.ops as op (opValue(op))}
              <option value={opValue(op)}>{opLabel(op)}</option>
            {/each}
          </optgroup>
        {/each}
      </Select>
    </Field>

    <div class="api-console-host" bind:this={host}></div>

    <p class="api-console-note">{t("apiConsole.note", { version: RAPIDOC_VERSION })}</p>
  {/if}
</div>

<style>
  .api-console {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  .api-console-host {
    min-height: 12rem;
    min-width: 0;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    overflow: hidden;
  }
  .api-console-note {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
