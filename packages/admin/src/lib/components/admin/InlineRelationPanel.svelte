<script lang="ts">
  import { t } from "$lib/i18n";
  import { Plus, RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";

  import type { InlineRelationConfig, SchemaColumn } from "$lib/types/admin";

  interface Props {
    grimoireId?: string;
    parentTable: string;
    parentId: string;
    /** Pre-configured relations. If not provided, auto-detected from grimoire. */
    relations?: InlineRelationConfig[];
  }

  const { grimoireId, parentTable, parentId, relations: propRelations }: Props = $props();

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  let inlineRelations = $state<InlineRelationConfig[]>([]);
  $effect(() => {
    inlineRelations = propRelations || [];
  });
  const relationData = $state<Record<string, any[]>>({});
  const relationSchemas = $state<Record<string, SchemaColumn[]>>({});
  let loading = $state<Record<string, boolean>>({});
  let showCreateModal = $state<Record<string, boolean>>({});

  onMount(async () => {
    if (inlineRelations.length === 0 && grimoireId) {
      await autoDetectRelations();
    }
    await loadAllRelations();
  });

  async function autoDetectRelations() {
    try {
      const res = await fetch(`${API_URL}/api/explorer/discover/${grimoireId}`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const result = await res.json();
      const tables = result.tables || [];
      const detected: InlineRelationConfig[] = [];

      for (const tbl of tables) {
        if (tbl.name === parentTable) continue;
        try {
          const schemaRes = await fetch(`${API_URL}/api/explorer/schema/json/${tbl.name}`, {
            credentials: "include",
          });
          if (!schemaRes.ok) continue;
          const schema = await schemaRes.json();
          const props = schema.properties || {};
          for (const [colName, prop] of Object.entries(props)) {
            const p = prop as any;
            if (p["x-relation"] && p["x-relation"].table === parentTable) {
              detected.push({
                table: tbl.name,
                fkColumn: colName,
                title: tbl.label || humanize(tbl.name),
              });
            }
          }
        } catch {
          /* skip */
        }
      }
      inlineRelations = detected;
    } catch {
      console.warn("[InlineRelationPanel] Auto-detect failed");
    }
  }

  async function loadAllRelations() {
    for (const rel of inlineRelations) {
      await loadRelation(rel);
    }
  }

  async function loadRelation(rel: InlineRelationConfig) {
    loading[rel.table] = true;
    loading = { ...loading };
    try {
      const params = new URLSearchParams();
      params.set("filter_field", rel.fkColumn);
      params.set("filter_op", "equals");
      params.set("filter_value", parentId);
      params.set("limit", "50");

      const res = await fetch(`${API_URL}/api/explorer/${rel.table}?${params}`, {
        credentials: "include",
      });
      if (res.ok) {
        const result = await res.json();
        relationData[rel.table] = result.data || result.docs || result;
      }
    } catch (e) {
      console.error(`[InlineRelationPanel] Failed to load ${rel.table}:`, e);
    } finally {
      loading[rel.table] = false;
      loading = { ...loading };
    }
  }

  async function loadRelationSchema(rel: InlineRelationConfig) {
    if (relationSchemas[rel.table]) return;
    try {
      const res = await fetch(`${API_URL}/api/explorer/schema/json/${rel.table}`, {
        credentials: "include",
      });
      if (res.ok) {
        const schema = await res.json();
        const cols: SchemaColumn[] = Object.entries(schema.properties || {}).map(
          ([name, prop]: [string, any]) => ({
            name,
            type: prop.type || "text",
            nullable: !schema.required?.includes(name),
          })
        );
        relationSchemas[rel.table] = cols;
      }
    } catch {
      relationSchemas[rel.table] = [];
    }
  }

  function getRelationColumns(rel: InlineRelationConfig): string[] {
    if (rel.columns && rel.columns.length > 0) return rel.columns;
    const schema = relationSchemas[rel.table];
    if (schema) {
      return schema
        .filter(
          (c) =>
            !c.name.endsWith("_id") &&
            !c.name.endsWith("Id") &&
            c.name !== "id" &&
            !c.name.endsWith("At")
        )
        .slice(0, 4)
        .map((c) => c.name);
    }
    const data = relationData[rel.table];
    if (data && data.length > 0) {
      return Object.keys(data[0])
        .filter((k) => k !== "id" && !k.endsWith("_id") && !k.endsWith("Id") && !k.endsWith("At"))
        .slice(0, 4);
    }
    return [];
  }

  function formatCell(val: any): string {
    if (val === null || val === undefined) return "—";
    if (typeof val === "boolean") return val ? "Yes" : "No";
    if (typeof val === "object") return JSON.stringify(val).slice(0, 30);
    return String(val);
  }

  function humanize(str: string): string {
    return str
      .replace(/[-_]/g, " ")
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (s) => s.toUpperCase())
      .trim();
  }

  async function createRelatedRecord(rel: InlineRelationConfig) {
    await loadRelationSchema(rel);
    showCreateModal[rel.table] = true;
    showCreateModal = { ...showCreateModal };
  }
</script>

<div class="space-y-6 mt-6">
  <div class="border-t border-kitsuden-border pt-4">
    <h3 class="text-sm font-semibold text-kitsuden-text mb-4 flex items-center gap-2">
      <span class="w-1.5 h-1.5 rounded-full bg-kitsuden-accent"></span>
      {t("inlineRelationPanel.relations")}
    </h3>

    {#if inlineRelations.length === 0}
      <p class="text-xs text-kitsuden-subtle">
        {t("inlineRelationPanel.noInlineRelationsDetected")}
      </p>
    {/if}

    {#each inlineRelations as rel}
      {@const data = relationData[rel.table] || []}
      {@const cols = getRelationColumns(rel)}
      <div class="mb-4 border border-kitsuden-border rounded-lg bg-kitsuden-card overflow-hidden">
        <div
          class="flex items-center justify-between px-4 py-2.5 bg-kitsuden-bg border-b border-kitsuden-border"
        >
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-kitsuden-text">{rel.title}</span>
            <span
              class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-kitsuden-surface text-kitsuden-subtle border border-kitsuden-border"
            >
              {data.length}
            </span>
          </div>
          <div class="flex items-center gap-1">
            <button
              class="p-1.5 rounded-md hover:bg-kitsuden-border/30 text-kitsuden-text-dim transition-colors"
              title={t("inlineRelationPanel.update")}
              onclick={() => loadRelation(rel)}
            >
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
            <button
              class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md bg-kitsuden-accent/10 text-kitsuden-accent hover:bg-kitsuden-accent/20 transition-colors"
              onclick={() => createRelatedRecord(rel)}
            >
              <Plus class="w-3 h-3" />
              {t("inlineRelationPanel.add")}
            </button>
          </div>
        </div>

        {#if loading[rel.table]}
          <div class="p-4 space-y-2">
            {#each Array(3) as _}
              <div class="h-4 bg-kitsuden-border/30 rounded animate-pulse"></div>
            {/each}
          </div>
        {:else if data.length === 0}
          <div class="p-4 text-center">
            <p class="text-xs text-kitsuden-subtle">
              {t("inlineRelationPanel.withoutRelatedRecords")}
            </p>
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-kitsuden-border bg-kitsuden-bg/50">
                  {#each cols as col}
                    <th
                      class="px-3 py-2 text-left text-kitsuden-subtle font-medium uppercase tracking-wider"
                    >
                      {humanize(col)}
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each data as record}
                  <tr
                    class="border-b border-kitsuden-border/50 hover:bg-kitsuden-accent/[0.02] transition-colors"
                  >
                    {#each cols as col}
                      <td class="px-3 py-2 text-kitsuden-text-dim">
                        {formatCell(record[col])}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
