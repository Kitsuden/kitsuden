<!--
  The one command palette (tallao Command) and the keyboard that goes with it:

    /  or  Ctrl/Cmd+K   open the palette
    ?                   the shortcuts sheet
    g then a letter     jump to a section (the letters come from `$lib/nav`)

  It lists pages, "New …" actions, recently opened records (real history, per user) and,
  while typing, records found in the datasets (their own search endpoint) and the models.
  What it lists is built in `$lib/palette.ts`.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { api } from "$lib/api";
  import { t } from "$lib/i18n";
  import { jumpTargets, type NavGroup } from "$lib/nav";
  import {
    createItems,
    isTypingTarget,
    jumpFor,
    matchRows,
    pageItems,
    recentItems,
    recordItems,
    type FoundRecord,
    type PaletteItem,
  } from "$lib/palette";
  import type { RecentItem } from "$lib/recent";
  import { listModels, modelPath, type MountedModel } from "$lib/services/models";
  import { datasetStore } from "$lib/states/datasets.svelte";
  import { Command, Kbd, Sheet } from "$lib/tallao";

  import { goto } from "$app/navigation";

  interface Props {
    open?: boolean;
    groups: NavGroup[];
    recent: RecentItem[];
    isAdmin: boolean;
    isStaff: boolean;
    datasetsOn: boolean;
  }

  let { open = $bindable(false), groups, recent, isAdmin, isStaff, datasetsOn }: Props = $props();

  let query = $state("");
  let helpOpen = $state(false);
  let models = $state<MountedModel[]>([]);
  let found = $state<FoundRecord[]>([]);
  let searching = $state(false);

  const targets = $derived(jumpTargets(groups));

  // The lists behind "New …" and the record search load the first time the palette opens.
  let primed = false;
  $effect(() => {
    if (!open || primed) return;
    primed = true;
    if (datasetsOn && datasetStore.datasets.length === 0) void datasetStore.fetchDatasets();
    if (isStaff) {
      listModels()
        .then((list) => (models = list))
        .catch(() => (models = []));
    }
  });

  const items = $derived<PaletteItem[]>([
    ...(query.trim() ? recordItems(found, query.trim(), t) : recentItems(recent, t)),
    ...pageItems(groups, t),
    ...createItems(
      {
        datasets: datasetStore.datasets.map((d) => ({ id: d.id, name: d.name, slug: d.slug })),
        models: models.map((m) => ({
          kon: m.kon,
          name: m.descriptor.name,
          plural: m.descriptor.plural,
          path: modelPath(m),
        })),
        isAdmin,
        datasetsOn,
      },
      t
    ),
    {
      id: "help:shortcuts",
      label: t("palette.shortcuts"),
      group: t("palette.groupHelp"),
      shortcut: "?",
      onSelect: () => (helpOpen = true),
    },
  ]);

  // ── Record search: debounced, the last request wins ──────────────────────────────
  const MAX_SOURCES = 8;
  /** The latest rows of each model, fetched once per session of the palette. */
  const modelRows = new Map<string, Promise<Record<string, unknown>[]>>();
  let run = 0;

  async function search(text: string, id: number) {
    const results: FoundRecord[] = [];
    const jobs: Promise<void>[] = [];
    if (datasetsOn) {
      for (const d of datasetStore.datasets.slice(0, MAX_SOURCES)) {
        jobs.push(
          api
            .get<{ data?: Record<string, unknown>[] }>(
              `/api/datasets/${d.id}/search?q=${encodeURIComponent(text)}&limit=5`
            )
            .then((r) => {
              for (const row of r.data ?? []) {
                results.push({
                  source: d.name,
                  kind: "dataset",
                  href: `/datasets/${d.id}/entries/${String(row.id)}`,
                  row,
                });
              }
            })
            .catch(() => {})
        );
      }
    }
    for (const m of models.slice(0, MAX_SOURCES)) {
      if (!modelRows.has(m.base)) {
        modelRows.set(
          m.base,
          api
            .get<{ data?: Record<string, unknown>[] }>(`${m.base}?limit=50`)
            .then((r) => r.data ?? [])
            .catch(() => [])
        );
      }
      jobs.push(
        modelRows.get(m.base)!.then((rows) => {
          for (const row of matchRows(rows, text).slice(0, 5)) {
            results.push({
              source: m.descriptor.plural,
              kind: "model",
              href: `${modelPath(m)}/${String(row.id)}`,
              row,
              titleField: m.descriptor.title,
            });
          }
        })
      );
    }
    await Promise.all(jobs);
    if (id !== run) return;
    found = results;
    searching = false;
  }

  $effect(() => {
    const text = query.trim();
    const id = ++run;
    if (!open || text.length < 2) {
      found = [];
      searching = false;
      return;
    }
    searching = true;
    const timer = setTimeout(() => void search(text, id), 200);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!open) query = "";
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────────────
  let gPending = false;
  let gTimer: ReturnType<typeof setTimeout> | undefined;

  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    // A dialog in front owns the keyboard.
    if (document.querySelector("dialog[open]")) return;

    const jump = jumpFor(gPending, event.key, targets);
    if (gPending) {
      gPending = false;
      clearTimeout(gTimer);
      if (jump) {
        event.preventDefault();
        void goto(jump.path);
        return;
      }
    }
    if (event.key === "/") {
      event.preventDefault();
      open = true;
    } else if (event.key === "?") {
      event.preventDefault();
      helpOpen = true;
    } else if (event.key === "g") {
      gPending = true;
      gTimer = setTimeout(() => (gPending = false), 1500);
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      clearTimeout(gTimer);
    };
  });

  const jumpRows = $derived(
    [...targets.entries()].map(([letter, entry]) => ({
      letter,
      label: entry.label ?? (entry.labelKey ? t(entry.labelKey) : entry.id),
    }))
  );
</script>

<Command
  bind:open
  bind:query
  {items}
  loading={searching}
  placeholder={t("palette.placeholder")}
  label={t("palette.label")}
  emptyText={(q) => t("palette.empty", { query: q })}
/>

<Sheet bind:open={helpOpen} title={t("palette.shortcuts")} size="sm">
  <div class="kitsuden-keys" data-testid="shortcuts-sheet">
    <h3>{t("palette.keysGeneral")}</h3>
    <dl>
      <div>
        <dt>{t("palette.keyOpen")}</dt>
        <dd><Kbd keys={["/"]} /> <Kbd keys={["Mod", "K"]} /></dd>
      </div>
      <div>
        <dt>{t("palette.keyHelp")}</dt>
        <dd><Kbd keys={["?"]} /></dd>
      </div>
      <div>
        <dt>{t("palette.keyClose")}</dt>
        <dd><Kbd keys={["Esc"]} /></dd>
      </div>
    </dl>
    <h3>{t("palette.keysApprovals")}</h3>
    <dl>
      <div>
        <dt>{t("palette.keyNextPrev")}</dt>
        <dd><Kbd keys={["j"]} /> <Kbd keys={["k"]} /></dd>
      </div>
      <div>
        <dt>{t("palette.keyApprove")}</dt>
        <dd><Kbd keys={["a"]} /></dd>
      </div>
      <div>
        <dt>{t("palette.keyReject")}</dt>
        <dd><Kbd keys={["r"]} /></dd>
      </div>
    </dl>
    <h3>{t("palette.keysJump")}</h3>
    <dl>
      {#each jumpRows as row (row.letter)}
        <div>
          <dt>{row.label}</dt>
          <dd><Kbd keys={["g"]} /> <Kbd keys={[row.letter]} /></dd>
        </div>
      {/each}
    </dl>
  </div>
</Sheet>

<style>
  .kitsuden-keys h3 {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }
  .kitsuden-keys h3:first-child {
    margin-top: 0;
  }
  .kitsuden-keys dl {
    margin: 0;
  }
  .kitsuden-keys dl > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.375rem 0;
    font-size: 0.875rem;
    border-bottom: 1px solid rgb(var(--ta-border) / 0.6);
  }
  .kitsuden-keys dd {
    display: inline-flex;
    gap: 0.25rem;
    margin: 0;
  }
</style>
