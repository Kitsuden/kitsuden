<!--
  The record page: one record of any source, at its own URL (`…/<id>`, or `…/new`).

    PageHeader   the record's name, previous / next in the list it was opened from, Delete
    Fields       the model's form (DynamicForm) beside an "About" DescriptionList: id,
                 created, updated, by whom, the API path with a copy button
    Related      the rows of the kon's other tables that point at this record
    History      a Timeline of what the API keeps (see `$lib/list/history`): its change
                 history (who, a person or an agent, created / changed / deleted which fields),
                 snapshots and approval proposals, with a DiffView for each change; an
                 agent's proposal names the agent and who approved it
    SaveBar      sticky, with the unsaved state: Save (back to the list), "Save and continue
                 editing", "Save and add another"; leaving with changes asks first
-->
<script lang="ts">
  import { ChevronLeft, ChevronRight } from "lucide-svelte";
  import { untrack } from "svelte";

  import { isStaff } from "$lib/auth.svelte";
  import InlineRelationPanel from "$lib/components/admin/InlineRelationPanel.svelte";
  import UnsavedGuard from "$lib/components/feedback/UnsavedGuard.svelte";
  import DynamicForm from "$lib/components/forms/DynamicForm.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { localeFormat, t } from "$lib/i18n";
  import {
    historyLine,
    recordHistory,
    type ChangeLike,
    type HistoryEvent,
    type ProposalLike,
    type SnapshotLike,
  } from "$lib/list/history";
  import { neighboursOf } from "$lib/list/neighbours";
  import type { RecordSource, Row } from "$lib/list/source";
  import type { Crumb } from "$lib/nav";
  import { getProposal, listProposals } from "$lib/services/approvals";
  import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DescriptionList,
    DiffView,
    DropdownMenu,
    EmptyState,
    MenuItem,
    SaveBar,
    Skeleton,
    Tabs,
    Timeline,
    toast,
    type DescriptionItem,
    type TabItem,
  } from "$lib/tallao";

  import { goto } from "$app/navigation";

  interface Props {
    source: RecordSource;
    /** The record's id, or "new". */
    id: string;
    /** The list this record belongs to, and where a record of it lives. */
    listHref: string;
    hrefFor: (id: string) => string;
    /** Crumbs between the section and this record (the dataset, the kon's view). */
    crumbs?: Crumb[];
    canDelete?: boolean;
  }

  const { source, id, listHref, hrefFor, crumbs = [], canDelete = true }: Props = $props();

  const isNew = $derived(id === "new");
  const formId = $props.id();

  let row = $state<Row | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let missing = $state(false);
  let saving = $state(false);
  let saveError = $state<string | undefined>(undefined);
  let fieldErrors = $state<Record<string, string>>({});
  let dirty = $state(false);
  /** Leaving on purpose after a save: the unsaved guard stays quiet. */
  let leaving = $state(false);
  let section = $state("fields");
  /** Remounts the form: a saved record, or "add another", starts from clean values. */
  let formKey = $state(0);

  async function load() {
    loading = true;
    error = null;
    missing = false;
    row = null;
    try {
      if (!isNew) {
        row = await source.get(id);
        missing = row === null;
      }
    } catch (e) {
      error = (e as Error)?.message || t("record.loadFailed");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void source;
    void id;
    untrack(() => {
      section = "fields";
      dirty = false;
      leaving = false;
      saveError = undefined;
      fieldErrors = {};
      formKey += 1;
      void load();
    });
  });

  const initial = $derived(row ? source.formValues(row) : {});
  const name = $derived(
    isNew ? t("record.newTitle", { name: source.singular }) : row ? source.title(row) || id : id
  );
  const trail = $derived<Crumb[]>([...crumbs, { label: loading && !isNew ? "…" : name }]);
  const neighbours = $derived(
    isNew ? { previous: null, next: null, position: -1, total: 0 } : neighboursOf(source.id, id)
  );

  // ── Saving ───────────────────────────────────────────────────────────────────────
  type After = "list" | "stay" | "new";
  let after: After = "list";

  /** The API's field errors (`errors: { field: message }` or a list of issues), by field. */
  function fieldErrorsOf(e: unknown): Record<string, string> {
    const body = (e as { body?: Record<string, unknown> })?.body;
    const out: Record<string, string> = {};
    const details = body?.details as { fields?: unknown } | undefined;
    const errors = body?.errors ?? body?.issues ?? body?.fields ?? details?.fields;
    if (Array.isArray(errors)) {
      for (const item of errors as Array<Record<string, unknown>>) {
        const path = Array.isArray(item.path) ? item.path.join(".") : (item.field ?? item.path);
        if (typeof path === "string" && path) out[path] = String(item.message ?? item.error ?? "");
      }
    } else if (errors && typeof errors === "object") {
      for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
        out[key] = Array.isArray(value) ? String(value[0]) : String(value);
      }
    }
    return out;
  }

  async function save(values: Row) {
    if (saving) return;
    saving = true;
    saveError = undefined;
    fieldErrors = {};
    const intent = after;
    after = "list";
    try {
      let saved: Row;
      if (isNew) {
        saved = await source.create(values);
      } else {
        // Only what changed, unless the source stores the record whole.
        const changed = source.fullUpdate
          ? values
          : Object.fromEntries(
              Object.entries(values).filter(
                ([key, value]) =>
                  JSON.stringify(value ?? null) !== JSON.stringify(initial[key] ?? null)
              )
            );
        saved = Object.keys(changed).length > 0 ? await source.update(id, changed) : (row ?? {});
      }
      toast.success(
        isNew
          ? t("record.createdToast", { name: source.singular })
          : t("record.savedToast", { name: source.singular })
      );
      dirty = false;
      leaving = true;
      const savedId = source.rowId(saved) || (isNew ? "" : id);
      if (intent === "new") {
        if (isNew) {
          // Already on /new: start a clean form in place.
          leaving = false;
          formKey += 1;
        } else await goto(hrefFor("new"));
      } else if (intent === "stay" && savedId) {
        if (isNew) await goto(hrefFor(savedId), { replaceState: true });
        else {
          leaving = false;
          await load();
          formKey += 1;
        }
      } else await goto(listHref);
    } catch (e) {
      leaving = false;
      fieldErrors = fieldErrorsOf(e);
      saveError = (e as Error)?.message || t("record.saveFailed");
    } finally {
      saving = false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: t("list.deleteOneTitle", { name }),
      description: t("list.deleteDescription"),
      confirmLabel: t("common.delete"),
    });
    if (!ok) return;
    try {
      await source.remove(id);
      toast.success(t("list.deleted", { n: 1 }));
      leaving = true;
      await goto(listHref);
    } catch (e) {
      toast.error(t("list.deleteFailed", { n: 1 }), { description: (e as Error)?.message });
    }
  }

  // ── About ────────────────────────────────────────────────────────────────────────
  const dateTime = (iso?: string) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : new Intl.DateTimeFormat(localeFormat(), { dateStyle: "medium", timeStyle: "short" }).format(
          d
        );
  };
  const about = $derived(row ? source.about(row) : {});
  const aboutItems = $derived<DescriptionItem[]>(
    row
      ? [
          { label: t("record.id"), value: id, copy: true, mono: true },
          { label: t("record.createdLabel"), value: dateTime(about.created) },
          { label: t("record.createdByLabel"), value: about.createdBy ?? null },
          { label: t("record.updatedLabel"), value: dateTime(about.updated) },
          { label: t("record.updatedByLabel"), value: about.updatedBy ?? null },
          ...(source.apiPath(id)
            ? [{ label: t("record.apiPath"), value: source.apiPath(id), copy: true, mono: true }]
            : []),
        ]
      : []
  );

  // ── History ──────────────────────────────────────────────────────────────────────
  let events = $state<HistoryEvent[]>([]);
  let historyLoading = $state(false);
  let historyFor = "";

  async function loadHistory() {
    if (!row || isNew) return;
    const stamp = `${source.id}:${id}:${about.updated ?? ""}`;
    if (historyFor === stamp) return;
    historyFor = stamp;
    historyLoading = true;
    const apiPath = source.apiPath(id);
    let snapshots: SnapshotLike[] = [];
    let proposals: ProposalLike[] = [];
    let changes: ChangeLike[] = [];
    await Promise.all([
      source
        .history?.(id)
        .then((list) => (changes = list))
        .catch(() => {}),
      source
        .snapshots?.(id)
        .then((list) => (snapshots = list))
        .catch(() => {}),
      // Proposals are the team's to see: an agent asked, a person decided.
      isStaff() && apiPath
        ? listProposals({ limit: 200 })
            .then(async (r) => {
              const mine = r.proposals.filter(
                (p) =>
                  p.path
                    .split("?")[0]!
                    .replace(/\/+$/, "")
                    .replace("/api/data-sets/", "/api/datasets/") === apiPath
              );
              // The list has no diff: ask for the few that touch this record.
              proposals = (await Promise.all(
                mine.slice(0, 20).map((p) => getProposal(p.id).catch(() => p))
              )) as unknown as ProposalLike[];
            })
            .catch(() => {})
        : undefined,
    ]);
    const labels = Object.fromEntries(source.fields.map((f) => [f.key, f.label]));
    events = recordHistory({
      id,
      apiPath,
      about,
      snapshots,
      proposals,
      changes,
      labels,
      redactedText: t("record.redacted"),
    });
    historyLoading = false;
  }

  $effect(() => {
    if (row && !isNew) untrack(() => void loadHistory());
  });

  const lines = $derived(events.map((e) => historyLine(e, t, (iso) => dateTime(iso) ?? iso)));
  const changedEvents = $derived(events.filter((e) => e.changes.length > 0));

  const tabItems = $derived<TabItem[]>([
    {
      id: "fields",
      label: t("record.tabFields"),
      controls: `${formId}-fields`,
      tabId: `${formId}-tab-fields`,
    },
    {
      id: "history",
      label: t("record.tabHistory"),
      count: events.length || undefined,
      controls: `${formId}-history`,
      tabId: `${formId}-tab-history`,
    },
  ]);
</script>

<UnsavedGuard dirty={dirty && !leaving} />

<Page title={name} crumbs={trail}>
  {#snippet meta()}
    {#if isNew}
      {t("record.newMeta", { name: source.label })}
    {:else if row}
      {source.singular}
      {#if about.updated}· {t("record.updatedAt", { date: dateTime(about.updated) })}{/if}
      {#if neighbours.position >= 0}
        · {t("record.position", { n: neighbours.position + 1, total: neighbours.total })}
      {/if}
    {/if}
  {/snippet}

  {#snippet actions()}
    {#if !isNew}
      <Button
        variant="ghost"
        size="icon"
        href={neighbours.previous ? hrefFor(neighbours.previous) : undefined}
        disabled={!neighbours.previous}
        ariaLabel={t("record.previous")}
        title={t("record.previous")}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        href={neighbours.next ? hrefFor(neighbours.next) : undefined}
        disabled={!neighbours.next}
        ariaLabel={t("record.next")}
        title={t("record.next")}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </Button>
      {#if row}
        <DropdownMenu label={t("record.moreActions")} placement="bottom-end">
          {#snippet trigger(props)}
            <Button {...props} variant="secondary" size="icon" ariaLabel={t("record.moreActions")}>
              <span aria-hidden="true">⋯</span>
            </Button>
          {/snippet}
          <MenuItem onSelect={() => goto(hrefFor("new"))}>
            {t("list.newOne", { name: source.singular })}
          </MenuItem>
          {#if canDelete}
            <MenuItem variant="danger" onSelect={remove}>{t("common.delete")}</MenuItem>
          {/if}
        </DropdownMenu>
      {/if}
    {/if}
  {/snippet}

  {#snippet tabs()}
    {#if !isNew && row}
      <Tabs items={tabItems} bind:value={section} panels={false} ariaLabel={t("record.sections")} />
    {/if}
  {/snippet}

  {#if loading}
    <div class="kitsuden-record" aria-busy="true">
      <div class="kitsuden-record-fields">
        {#each Array(5) as _}
          <Skeleton width="100%" height="2.5rem" />
        {/each}
      </div>
    </div>
  {:else if error}
    <EmptyState variant="error" description={error} onRetry={load} />
  {:else if missing}
    <EmptyState
      title={t("record.notFound", { name: source.singular })}
      description={t("record.notFoundHint")}
      actionLabel={t("record.backToList", { name: source.label })}
      actionHref={listHref}
    />
  {:else}
    <div
      id="{formId}-fields"
      role={isNew ? undefined : "tabpanel"}
      aria-labelledby={isNew ? undefined : `${formId}-tab-fields`}
      hidden={section !== "fields"}
    >
      <div class="kitsuden-record">
        <div class="kitsuden-record-fields">
          {#if source.formFields.length === 0}
            <EmptyState
              size="sm"
              title={t("record.noFields")}
              description={t("record.noFieldsHint")}
            />
          {:else}
            {#key formKey}
              <DynamicForm
                fields={source.formFields}
                initialData={initial}
                {formId}
                actions={false}
                errors={fieldErrors}
                onDirtyChange={(d) => (dirty = d)}
                onSubmit={save}
              />
            {/key}
          {/if}

          {#if !isNew && source.inline}
            <InlineRelationPanel
              grimoireId={source.inline.konId}
              parentTable={source.inline.table}
              parentId={id}
            />
          {/if}
        </div>

        {#if row}
          <Card class="kitsuden-record-about">
            <CardHeader><CardTitle level={2}>{t("record.about")}</CardTitle></CardHeader>
            <CardContent>
              <DescriptionList
                ariaLabel={t("record.aboutOf", { name })}
                layout="stacked"
                items={aboutItems}
              />
            </CardContent>
          </Card>
        {/if}
      </div>

      {#if source.formFields.length > 0}
        <SaveBar
          form={formId}
          {dirty}
          {saving}
          error={saveError}
          disableWhenClean={!isNew}
          savedText={isNew ? t("record.notSavedYet") : t("record.allSaved")}
          saveLabel={t("record.save")}
          cancelLabel={dirty ? t("record.discard") : t("record.back")}
          onCancel={dirty ? () => ((formKey += 1), (dirty = false)) : undefined}
          cancelHref={dirty ? undefined : listHref}
          secondaryActions={[
            { id: "new", label: t("record.saveAndAdd"), onSelect: () => (after = "new") },
            { id: "stay", label: t("record.saveAndContinue"), onSelect: () => (after = "stay") },
          ]}
        />
      {/if}
    </div>

    {#if !isNew}
      <div
        id="{formId}-history"
        role="tabpanel"
        aria-labelledby="{formId}-tab-history"
        hidden={section !== "history"}
      >
        <div class="kitsuden-record-history">
          <section>
            <h2>{t("record.activity")}</h2>
            {#if historyLoading}
              <Skeleton lines={4} />
            {:else}
              <Timeline
                items={lines}
                ariaLabel={t("record.historyOf", { name })}
                locale={localeFormat()}
                emptyText={t("record.noHistory")}
              />
              <p class="kitsuden-record-note">{t("record.historyNote")}</p>
            {/if}
          </section>
          <section>
            <h2>{t("record.changes")}</h2>
            {#each changedEvents as event (event.id)}
              {@const line = historyLine(event, t, (iso) => dateTime(iso) ?? iso)}
              <h3>{line.title} · {line.date}</h3>
              <DiffView changes={event.changes} ariaLabel={`${line.title} · ${line.date}`} />
            {:else}
              <p class="kitsuden-record-note">{t("record.noChanges")}</p>
            {/each}
          </section>
        </div>
      </div>
    {/if}
  {/if}
</Page>

<style>
  .kitsuden-record {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 19rem;
    gap: 1.5rem;
    align-items: start;
  }
  .kitsuden-record-fields {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-width: 0;
    max-width: 46rem;
  }
  .kitsuden-record-history {
    display: grid;
    grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
    gap: 2rem;
    align-items: start;
  }
  .kitsuden-record-history h2 {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgb(var(--ta-text-dim));
  }
  .kitsuden-record-history h3 {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .kitsuden-record-history h3:first-of-type {
    margin-top: 0;
  }
  .kitsuden-record-note {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
  @media (max-width: 900px) {
    .kitsuden-record,
    .kitsuden-record-history {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
