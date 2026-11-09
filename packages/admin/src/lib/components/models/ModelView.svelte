<!--
  A model's view (defineModel), generated from its DESCRIPTOR:
  the paginated list, create and edit, without a line written for that
  model. The columns, form controls, required fields, enum
  values and limits come from the model; what the user cannot
  see or touch is decided by the API (permission + RLS), not by this view.

  Props: `descriptor` (GET <base>/_model or /api/models) and `base`, the
  collection route (`/api/notas/notes`).
-->
<script lang="ts">
  import type { DescribedField, ModelDescriptor } from "@kitsuden/shared";

  import { api } from "$lib/api";
  import { t } from "$lib/i18n";

  interface Props {
    descriptor: ModelDescriptor;
    base: string;
  }

  let { descriptor, base }: Props = $props();

  type Row = Record<string, unknown> & { id: string };

  const API = import.meta.env.VITE_API_URL ?? "";
  const PER_PAGE = 20;

  let rows = $state<Row[]>([]);
  let total = $state(0);
  let from = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let warning = $state<string | null>(null);
  /** `null`: list; `"new"`: create; a row: edit. */
  let editing = $state<Row | "new" | null>(null);
  let values = $state<Record<string, unknown>>({});
  let fieldFailures = $state<Record<string, string>>({});
  let saving = $state(false);

  /** The list's columns: the title first, then the short ones, up to five. */
  const columns = $derived.by(() => {
    const shortList = descriptor.fields.filter((c) => c.type !== "json" && c.type !== "longText");
    const title = shortList.find((c) => c.key === descriptor.title);
    return [...(title ? [title] : []), ...shortList.filter((c) => c !== title)].slice(0, 5);
  });

  async function request(method: string, route: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = api.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${route}`, {
      method: method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = new Error(
        String(data.detail ?? data.message ?? data.title ?? `HTTP ${res.status}`)
      ) as Error & {
        body?: Record<string, unknown>;
      };
      e.body = data;
      throw e;
    }
    return data;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const r = (await request("GET", `${base}?limit=${PER_PAGE}&offset=${from}`)) as {
        data: Row[];
        total: number;
      };
      rows = r.data;
      total = r.total;
    } catch (e) {
      error = (e as Error).message || t("models.errorLoading");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Reloads on model or page change.
    void base;
    void from;
    void load();
  });

  // ── Form values ↔ JSON ────────────────────────────────────────────────

  function aControl(c: DescribedField, v: unknown): unknown {
    if (v === null || v === undefined) return c.type === "boolean" ? false : "";
    if (c.type === "date") {
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) return "";
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }
    if (c.type === "json") return JSON.stringify(v, null, 2);
    if (c.type === "integer" || c.type === "number") return String(v);
    return v;
  }

  /** `undefined` = do not send; throws if the JSON cannot be read. */
  function fromControl(c: DescribedField, v: unknown): unknown {
    if (c.type === "boolean") return v === true;
    const text = typeof v === "string" ? v : v == null ? "" : String(v);
    if (text.trim() === "") return c.required ? undefined : null;
    switch (c.type) {
      case "integer":
      case "number":
        return Number(text);
      case "date":
        return new Date(text).toISOString();
      case "json":
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(c.key);
        }
      default:
        return text;
    }
  }

  function open(row: Row | "new") {
    editing = row;
    fieldFailures = {};
    warning = null;
    const v: Record<string, unknown> = {};
    for (const c of descriptor.fields) {
      v[c.key] = aControl(c, row === "new" ? (c.defaultValue ?? null) : row[c.key]);
    }
    values = v;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!editing) return;
    const body: Record<string, unknown> = {};
    fieldFailures = {};
    for (const c of descriptor.fields) {
      let value: unknown;
      try {
        value = fromControl(c, values[c.key]);
      } catch {
        fieldFailures = { ...fieldFailures, [c.key]: t("models.invalidJson") };
        continue;
      }
      if (value === undefined) continue;
      if (editing === "new" && value === null) continue;
      if (editing !== "new" && JSON.stringify(value) === JSON.stringify(editing[c.key] ?? null))
        continue;
      body[c.key] = value;
    }
    if (Object.keys(fieldFailures).length) return;
    saving = true;
    try {
      if (editing === "new") {
        await request("POST", base, body);
        warning = t("models.created");
      } else {
        await request("PATCH", `${base}/${editing.id}`, body);
        warning = t("models.saved");
      }
      editing = null;
      await load();
    } catch (e) {
      const detail = (e as Error & { body?: { details?: { fields?: Record<string, string[]> } } })
        .body;
      const fields = detail?.details?.fields ?? {};
      fieldFailures = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.join(" ")]));
      error = `${t("models.errorSaving")}: ${(e as Error).message}`;
    } finally {
      saving = false;
    }
  }

  async function remove(row: Row) {
    if (!confirm(t("models.confirmDelete"))) return;
    try {
      await request("DELETE", `${base}/${row.id}`);
      warning = t("models.deleted");
      await load();
    } catch (e) {
      error = `${t("models.errorDeleting")}: ${(e as Error).message}`;
    }
  }

  function show(c: DescribedField, v: unknown): string {
    if (v === null || v === undefined || v === "") return t("models.none");
    if (c.type === "boolean") return v ? t("models.yes") : t("models.no");
    if (c.type === "date") return new Date(String(v)).toLocaleString();
    return String(v);
  }
</script>

<section class="space-y-4" data-testid="model-view" data-model={descriptor.name}>
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-lg font-semibold text-zinc-100">{descriptor.tag}</h2>
      <p class="text-sm text-zinc-400">{descriptor.description}</p>
      <p class="mt-1 text-xs text-zinc-500">
        {t("models.readAccess", { value: t(`models.access_${descriptor.access.read}`) })} ·
        {t("models.writeAccess", { value: t(`models.access_${descriptor.access.write}`) })} ·
        {t("models.scopes", { read: descriptor.scopes.read, write: descriptor.scopes.write })}
      </p>
    </div>
    {#if editing === null}
      <button class="btn-primary btn-sm" data-testid="model-new" onclick={() => open("new")}
        >{t("models.newRow")}</button
      >
    {/if}
  </header>

  {#if error}
    <div
      class="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
      role="alert"
    >
      {error}
    </div>
  {/if}
  {#if warning}
    <div
      class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300"
      role="status"
    >
      {warning}
    </div>
  {/if}

  {#if editing !== null}
    <form class="card p-4 space-y-3" data-testid="model-form" onsubmit={save}>
      <h3 class="text-sm font-semibold text-zinc-200">
        {editing === "new"
          ? t("models.createTitle", { model: descriptor.tag })
          : t("models.editTitle", { model: descriptor.tag })}
      </h3>
      {#each descriptor.fields as c (c.key)}
        <div class="space-y-1">
          <label class="text-xs text-zinc-400" for={`field-${c.key}`}>
            {c.tag}{#if c.required}<span class="text-zinc-500"> ({t("models.required")})</span>{/if}
          </label>
          {#if c.type === "boolean"}
            <input
              id={`field-${c.key}`}
              type="checkbox"
              checked={values[c.key] === true}
              onchange={(e) => (values[c.key] = (e.currentTarget as HTMLInputElement).checked)}
            />
          {:else if c.type === "enum"}
            <select
              id={`field-${c.key}`}
              class="input w-full text-sm"
              bind:value={values[c.key]}
              required={c.required}
            >
              {#if !c.required}<option value="">{t("models.none")}</option>{/if}
              {#each c.values ?? [] as v (v)}<option value={v}>{v}</option>{/each}
            </select>
          {:else if c.type === "longText" || c.type === "json"}
            <textarea
              id={`field-${c.key}`}
              class="input w-full text-sm font-mono"
              rows={c.type === "json" ? 4 : 5}
              maxlength={c.max}
              bind:value={values[c.key]}
            ></textarea>
          {:else if c.type === "integer" || c.type === "number"}
            <input
              id={`field-${c.key}`}
              type="number"
              class="input w-full text-sm"
              step={c.type === "integer" ? 1 : "any"}
              min={c.min}
              max={c.max}
              required={c.required && c.defaultValue === undefined}
              bind:value={values[c.key]}
            />
          {:else if c.type === "date"}
            <input
              id={`field-${c.key}`}
              type="datetime-local"
              class="input w-full text-sm"
              bind:value={values[c.key]}
            />
          {:else}
            <input
              id={`field-${c.key}`}
              type="text"
              class="input w-full text-sm"
              maxlength={c.max}
              minlength={c.min}
              required={c.required && c.defaultValue === undefined}
              bind:value={values[c.key]}
            />
          {/if}
          {#if c.description}<p class="text-[11px] text-zinc-500">{c.description}</p>{/if}
          {#if fieldFailures[c.key]}<p class="text-xs text-red-400" data-testid={`error-${c.key}`}>
              {fieldFailures[c.key]}
            </p>{/if}
        </div>
      {/each}
      <div class="flex gap-2">
        <button type="submit" class="btn-primary btn-sm" disabled={saving} data-testid="model-save"
          >{t("models.save")}</button
        >
        <button type="button" class="btn-ghost btn-sm" onclick={() => (editing = null)}
          >{t("models.cancel")}</button
        >
      </div>
    </form>
  {:else if loading}
    <p class="text-sm text-zinc-500">{t("models.loading")}</p>
  {:else if rows.length === 0}
    <div class="card p-12 text-center text-sm text-zinc-500">{t("models.noRows")}</div>
  {:else}
    <div class="overflow-x-auto rounded-lg border border-zinc-800">
      <table class="w-full text-sm" data-testid="model-table">
        <thead class="text-left text-xs text-zinc-500">
          <tr>
            {#each columns as c (c.key)}<th class="px-3 py-2">{c.tag}</th>{/each}
            {#if descriptor.withOwner}<th class="px-3 py-2">{t("models.owner")}</th>{/if}
            <th class="px-3 py-2">{t("models.updatedAt")}</th>
            <th class="px-3 py-2 text-right">{t("models.actions")}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-800/70">
          {#each rows as row (row.id)}
            <tr>
              {#each columns as c (c.key)}<td class="px-3 py-2 text-zinc-200"
                  >{show(c, row[c.key])}</td
                >{/each}
              {#if descriptor.withOwner}<td class="px-3 py-2 text-zinc-400"
                  >{String(row.ownerId ?? t("models.none"))}</td
                >{/if}
              <td class="px-3 py-2 text-zinc-400"
                >{new Date(String(row.updatedAt)).toLocaleString()}</td
              >
              <td class="px-3 py-2 text-right whitespace-nowrap">
                <button class="btn-ghost btn-sm" onclick={() => open(row)}
                  >{t("models.edit")}</button
                >
                <button class="btn-ghost btn-sm text-red-400" onclick={() => remove(row)}
                  >{t("models.delete")}</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between text-xs text-zinc-500">
      <span>{t("models.rows", { n: total })}</span>
      <span class="flex gap-2">
        <button
          class="btn-ghost btn-sm"
          disabled={from === 0}
          onclick={() => (from = Math.max(0, from - PER_PAGE))}>{t("models.previous")}</button
        >
        <button
          class="btn-ghost btn-sm"
          disabled={from + PER_PAGE >= total}
          onclick={() => (from += PER_PAGE)}>{t("models.next")}</button
        >
      </span>
    </div>
  {/if}
</section>
