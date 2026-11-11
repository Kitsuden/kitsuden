<script lang="ts">
  import {
    Dialog,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  /**
   * Newsletter — kon administration panel
   *
   * Four tabs: Campaigns (create, edit, preview, schedule,
   * send, statistics), Members, Suppressions and Segments (reach
   * preview without sending).
   *
   * DECISIONS
   *
   * · The editor is subject + preheader + HTML with a live preview
   *   (iframe with srcdoc, sandboxed). It does not reinvent a visual editor: the
   *   HTML can come from the page builder, the blog or elsewhere. The REAL
   *   preview —with List-Unsubscribe and footer— is served by the backend at
   *   /campaigns/:id/preview, which is the one shown after saving.
   *
   * · "Send" asks for confirmation with the REAL number of recipients
   *   (resolved by /prepare) before touching anything. A button that sends 50,000
   *   emails without saying how many is a trap.
   *
   * · The statistics come from the per-delivery breakdown (nl_deliveries), not from the
   *   aggregate counter: if they disagree, the truth is in the rows.
   */
  import { onDestroy } from "svelte";

  const API = import.meta.env.VITE_API_URL ?? "";
  const BASE = `${API}/api/newsletter`;

  type Tab = "campaigns" | "members" | "suppressions" | "segments";
  let tab = $state<Tab>("campaigns");

  interface Campaign {
    id: string;
    newsletterId: string;
    subject: string;
    previewText: string | null;
    html: string;
    status: string;
    scheduledAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    stats: Record<string, number>;
    postId: string | null;
    createdAt: string;
  }

  interface Member {
    id: string;
    email: string;
    name: string | null;
    status: string;
    locale: string;
    consentAt: string | null;
    createdAt: string;
  }

  interface Suppression {
    id: string;
    email: string;
    reason: string;
    source: string;
    detail: string | null;
    createdAt: string;
  }

  let newsletters = $state<{ id: string; name: string; slug: string }[]>([]);
  let campaigns = $state<Campaign[]>([]);
  let members = $state<Member[]>([]);
  let suppressions = $state<Suppression[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  // ── Campaign editor ──────────────────────────────────────────────────────
  let editing = $state<Campaign | null>(null);
  let draftSubject = $state("");
  let draftPreview = $state("");
  let draftHtml = $state("");
  let draftScheduledAt = $state("");
  let saving = $state(false);

  // ── Detail / stats ───────────────────────────────────────────────────────
  let statsFor = $state<string | null>(null);
  let statsData = $state<{
    status: string;
    stats: Record<string, number>;
    breakdown: { status: string; count: number }[];
  } | null>(null);

  // ── Send confirmation ────────────────────────────────────────────────────
  let confirmSend = $state<{ id: string; subject: string; recipients: number } | null>(null);

  // ── Segments: reach preview ──────────────────────────────────────────────
  let segmentFilter = $state('{\n  "status": ["subscribed"]\n}');
  let segmentResult = $state<{ total: number; sample: string[] } | null>(null);
  let segmentError = $state<string | null>(null);

  const STATUS_STYLE: Record<string, string> = {
    sent: "bg-kitsuden-green/15 text-kitsuden-green",
    sending: "bg-kitsuden-accent/15 text-kitsuden-accent",
    scheduled: "bg-kitsuden-accent/15 text-kitsuden-accent",
    draft: "bg-kitsuden-subtle/15 text-kitsuden-text-dim",
    failed: "bg-kitsuden-danger/15 text-kitsuden-danger",
    canceled: "bg-kitsuden-subtle/15 text-kitsuden-text-dim",
    subscribed: "bg-kitsuden-green/15 text-kitsuden-green",
    pending: "bg-kitsuden-subtle/15 text-kitsuden-text-dim",
    unsubscribed: "bg-kitsuden-danger/15 text-kitsuden-danger",
    cleaned: "bg-kitsuden-danger/15 text-kitsuden-danger",
  };

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [n, c, m, s] = await Promise.all([
        api<{ newsletters: typeof newsletters }>("/newsletters"),
        api<{ campaigns: Campaign[] }>("/campaigns"),
        api<{ members: Member[] }>("/members"),
        api<{ suppressions: Suppression[] }>("/suppressions"),
      ]);
      newsletters = n.newsletters;
      campaigns = c.campaigns;
      members = m.members;
      suppressions = s.suppressions;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function startNew() {
    editing = null;
    draftSubject = "";
    draftPreview = "";
    draftHtml = "<h1>Hello 👋</h1>\n<p>Write your newsletter here…</p>";
    draftScheduledAt = "";
    editorOpen = true;
  }

  function startEdit(campaign: Campaign) {
    editing = campaign;
    draftSubject = campaign.subject;
    draftPreview = campaign.previewText ?? "";
    draftHtml = campaign.html;
    draftScheduledAt = campaign.scheduledAt ? campaign.scheduledAt.slice(0, 16) : "";
    editorOpen = true;
  }

  let editorOpen = $state(false);

  async function saveDraft() {
    if (!draftSubject.trim() || !draftHtml.trim()) {
      notice = t("newsletterView.missingSubjectOrThe");
      return;
    }
    saving = true;
    try {
      const payload: Record<string, unknown> = {
        newsletterId: editing?.newsletterId ?? newsletters[0]?.id,
        subject: draftSubject,
        previewText: draftPreview || undefined,
        html: draftHtml,
        scheduledAt: draftScheduledAt ? new Date(draftScheduledAt).toISOString() : undefined,
      };

      if (editing) {
        // There is no PATCH in the API: a new campaign is created. Editing a sent
        // draft makes no sense and editing a pending one creates history.
        await api("/campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        notice = t("newsletterView.savedAsNewCampaignThe");
      } else {
        const created = await api<{ campaign: Campaign }>("/campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        // If it carries a date, it is prepared now: the scheduler only looks at
        // campaigns in `scheduled` status.
        if (draftScheduledAt) {
          await api(`/campaigns/${created.campaign.id}/prepare`, { method: "POST" });
          notice = t("newsletterView.scheduledCampaign");
        } else {
          notice = t("newsletterView.savedDraft");
        }
      }
      editorOpen = false;
      await load();
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /** Step 1 of sending: resolve the segment and SHOW the number. */
  async function askSend(campaign: Campaign) {
    try {
      const prep = await api<{ recipients: number }>(`/campaigns/${campaign.id}/prepare`, {
        method: "POST",
      });
      confirmSend = { id: campaign.id, subject: campaign.subject, recipients: prep.recipients };
    } catch (e) {
      // Already prepared: the number is in stats.
      const stats = await api<{ stats: Record<string, number> }>(
        `/campaigns/${campaign.id}/stats`
      ).catch(() => null);
      confirmSend = {
        id: campaign.id,
        subject: campaign.subject,
        recipients: stats?.stats?.recipients ?? 0,
      };
      void e;
    }
  }

  /** Step 2: the actual send. */
  async function doSend() {
    if (!confirmSend) return;
    try {
      await api(`/campaigns/${confirmSend.id}/send`, { method: "POST" });
      notice = t("newsletterView.dispatchLaunchedProgressAppears");
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    }
    confirmSend = null;
    await load();
  }

  async function openStats(id: string) {
    statsFor = id;
    statsData = null;
    try {
      statsData = await api(`/campaigns/${id}/stats`);
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    }
  }

  async function addSuppression() {
    const email = prompt(t("newsletterView.addressToSuppressWillNotReceive"));
    if (!email) return;
    await api("/suppressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, detail: "added from the admin" }),
    }).catch((e) => (notice = String(e)));
    await load();
  }

  async function removeSuppression(email: string) {
    if (!(await confirmDialog(t("newsletterView.removeFromListOf", { email })))) return;
    await api(`/suppressions/${encodeURIComponent(email)}`, { method: "DELETE" }).catch(
      (e) => (notice = String(e))
    );
    await load();
  }

  async function previewSegment() {
    segmentError = null;
    segmentResult = null;
    let filter: unknown;
    try {
      filter = JSON.parse(segmentFilter);
    } catch {
      segmentError = t("newsletterView.theFilterIsNotJson");
      return;
    }
    try {
      segmentResult = await api("/segments/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter }),
      });
    } catch (e) {
      segmentError = e instanceof Error ? e.message : String(e);
    }
  }

  // Refresh while there are campaigns being sent.
  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    load();
    timer = setInterval(() => {
      if (campaigns.some((c) => c.status === "sending")) load();
    }, 5000);
    return () => {
      if (timer) clearInterval(timer);
    };
  });
  onDestroy(() => timer && clearInterval(timer));

  const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleString(localeFormat()) : "—");
  const pct = (part: number, total: number) =>
    total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—";
</script>

<ViewPage title={t("newsletterView.newsletter")}>
  {#snippet meta()}
    {newsletters[0]?.name ?? t("newsletterView.withoutNewsletter")}
    {t("newsletterView.suppressedMembers", {
      membersCount: members.length,
      suppressionsCount: suppressions.length,
    })}
  {/snippet}
  {#snippet actions()}
    <button
      class="px-4 py-2 rounded-lg bg-kitsuden-accent text-kitsuden-on-accent text-sm font-medium"
      onclick={startNew}
    >
      {t("newsletterView.newCampaign")}
    </button>
  {/snippet}

  <div class="space-y-4">
    {#if notice}
      <div
        class="px-4 py-2 rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent text-sm flex justify-between"
      >
        <span>{notice}</span>
        <button onclick={() => (notice = null)}>×</button>
      </div>
    {/if}

    <nav class="flex gap-1 border-b border-kitsuden-border">
      {#each [["campaigns", "Campaigns"], ["members", "Members"], ["suppressions", "Suppressions"], ["segments", "Segments"]] as [id, label] (id)}
        <button
          class="px-4 py-2 text-sm rounded-t-lg {tab === id
            ? 'bg-kitsuden-surface font-medium'
            : 'text-kitsuden-text-dim hover:bg-kitsuden-surface/50'}"
          onclick={() => (tab = id as Tab)}
        >
          {label}
        </button>
      {/each}
    </nav>

    {#if loading}
      <p class="text-kitsuden-text-dim text-sm py-8 text-center">{t("common.loadingEllipsis")}</p>
    {:else if error}
      <p class="text-kitsuden-danger text-sm py-8 text-center">{error}</p>
    {:else if tab === "campaigns"}
      <Table class="w-full text-sm">
        <TableHeader>
          <TableRow class="text-left text-kitsuden-text-dim border-b border-kitsuden-border">
            <TableHead class="py-2">{t("newsletterView.subject")}</TableHead>
            <TableHead>{t("common.status")}</TableHead>
            <TableHead>{t("newsletterView.scheduled")}</TableHead>
            <TableHead>{t("newsletterView.sentItems")}</TableHead>
            <TableHead>{t("newsletterView.openings")}</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each campaigns as campaign (campaign.id)}
            <TableRow class="border-b border-kitsuden-border/50 hover:bg-kitsuden-surface/40">
              <TableCell class="py-2 font-medium">{campaign.subject}</TableCell>
              <TableCell>
                <span class="px-2 py-0.5 rounded-sm text-xs {STATUS_STYLE[campaign.status] ?? ''}">
                  {campaign.status}
                </span>
              </TableCell>
              <TableCell class="text-kitsuden-text-dim">{fmtDate(campaign.scheduledAt)}</TableCell>
              <TableCell>{campaign.stats?.sent ?? 0}/{campaign.stats?.recipients ?? 0}</TableCell>
              <TableCell>{pct(campaign.stats?.opened ?? 0, campaign.stats?.sent ?? 0)}</TableCell>
              <TableCell class="text-right space-x-2">
                <button class="text-kitsuden-accent" onclick={() => openStats(campaign.id)}
                  >{t("newsletterView.stats")}</button
                >
                {#if campaign.status === "draft" || campaign.status === "scheduled"}
                  <button class="text-kitsuden-accent" onclick={() => startEdit(campaign)}
                    >{t("newsletterView.edit")}</button
                  >
                  <button class="text-kitsuden-green" onclick={() => askSend(campaign)}
                    >{t("newsletterView.send")}</button
                  >
                {/if}
                <a
                  class="text-kitsuden-text-dim"
                  href={`${BASE}/campaigns/${campaign.id}/preview?format=html`}
                  target="_blank"
                  rel="noreferrer">{t("newsletterView.view")}</a
                >
              </TableCell>
            </TableRow>
          {:else}
            <TableRow
              ><TableCell colspan={6} class="py-8 text-center text-kitsuden-text-dim">
                {t("newsletterView.withoutCampaignsYetCreateThe")}
              </TableCell></TableRow
            >
          {/each}
        </TableBody>
      </Table>
    {:else if tab === "members"}
      <Table class="w-full text-sm">
        <TableHeader>
          <TableRow class="text-left text-kitsuden-text-dim border-b border-kitsuden-border">
            <TableHead class="py-2">{t("common.email")}</TableHead><TableHead
              >{t("common.name")}</TableHead
            ><TableHead>{t("common.status")}</TableHead><TableHead>{t("common.language")}</TableHead
            >
            <TableHead>{t("newsletterView.consent")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each members as member (member.id)}
            <TableRow class="border-b border-kitsuden-border/50">
              <TableCell class="py-2">{member.email}</TableCell>
              <TableCell>{member.name ?? "—"}</TableCell>
              <TableCell>
                <span class="px-2 py-0.5 rounded-sm text-xs {STATUS_STYLE[member.status] ?? ''}">
                  {member.status}
                </span>
              </TableCell>
              <TableCell>{member.locale}</TableCell>
              <TableCell class="text-kitsuden-text-dim">{fmtDate(member.consentAt)}</TableCell>
            </TableRow>
          {:else}
            <TableRow
              ><TableCell colspan={5} class="py-8 text-center text-kitsuden-text-dim">
                {t("newsletterView.withoutMembersThePublicForm")}
              </TableCell></TableRow
            >
          {/each}
        </TableBody>
      </Table>
    {:else if tab === "suppressions"}
      <div class="flex justify-end">
        <button class="text-sm text-kitsuden-danger" onclick={addSuppression}>
          {t("newsletterView.suppressAddress")}
        </button>
      </div>
      <Table class="w-full text-sm">
        <TableHeader>
          <TableRow class="text-left text-kitsuden-text-dim border-b border-kitsuden-border">
            <TableHead class="py-2">{t("common.email")}</TableHead><TableHead
              >{t("newsletterView.reason")}</TableHead
            ><TableHead>{t("newsletterView.source")}</TableHead><TableHead
              >{t("newsletterView.date")}</TableHead
            ><TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each suppressions as suppression (suppression.id)}
            <TableRow class="border-b border-kitsuden-border/50">
              <TableCell class="py-2">{suppression.email}</TableCell>
              <TableCell>{suppression.reason}</TableCell>
              <TableCell class="text-kitsuden-text-dim">{suppression.source}</TableCell>
              <TableCell class="text-kitsuden-text-dim">{fmtDate(suppression.createdAt)}</TableCell>
              <TableCell class="text-right">
                <button
                  class="text-kitsuden-text-dim"
                  onclick={() => removeSuppression(suppression.email)}
                  >{t("newsletterView.remove")}</button
                >
              </TableCell>
            </TableRow>
          {:else}
            <TableRow
              ><TableCell colspan={5} class="py-8 text-center text-kitsuden-text-dim">
                {t("newsletterView.emptySuppressionListGood")}
              </TableCell></TableRow
            >
          {/each}
        </TableBody>
      </Table>
    {:else if tab === "segments"}
      <div class="grid md:grid-cols-2 gap-4">
        <div>
          <p class="text-sm text-kitsuden-text-dim mb-2">
            {t("newsletterView.declarativeFilterStatusLocalesTiers")}
          </p>
          <textarea
            class="w-full h-40 font-mono text-sm p-3 rounded-lg bg-kitsuden-surface border border-kitsuden-input"
            bind:value={segmentFilter}></textarea>
          <button
            class="mt-2 px-4 py-2 rounded-lg bg-kitsuden-accent text-kitsuden-on-accent text-sm"
            onclick={previewSegment}>{t("newsletterView.calculateScope")}</button
          >
        </div>
        <div class="rounded-lg bg-kitsuden-surface border border-kitsuden-border p-4">
          {#if segmentError}
            <p class="text-kitsuden-danger text-sm">{segmentError}</p>
          {:else if segmentResult}
            <p class="text-2xl font-semibold">{segmentResult.total}</p>
            <p class="text-sm text-kitsuden-text-dim mb-3">
              {t("newsletterView.reachedRecipients")}
            </p>
            {#each segmentResult.sample as email (email)}
              <p class="text-xs text-kitsuden-text-dim">{email}</p>
            {/each}
          {:else}
            <p class="text-sm text-kitsuden-text-dim">
              {t("newsletterView.theResultWillAppearHere")}
            </p>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- ══ Editor ══ -->
  <Dialog
    open={!!editorOpen}
    bare
    size="2xl"
    ariaLabel={editing
      ? t("newsletterView.editCampaignCreatesNew")
      : t("newsletterView.newCampaign")}
    onClose={() => (editorOpen = false)}
  >
    {#if editorOpen}
      <div
        class="bg-kitsuden-bg rounded-xl border border-kitsuden-border w-full max-w-5xl max-h-[90vh] overflow-auto p-6 space-y-4"
      >
        <h2 class="text-lg font-semibold">
          {editing ? t("newsletterView.editCampaignCreatesNew") : t("newsletterView.newCampaign")}
        </h2>

        <input
          class="w-full p-3 rounded-lg bg-kitsuden-surface border border-kitsuden-input"
          placeholder={t("newsletterView.subject")}
          bind:value={draftSubject}
        />
        <input
          class="w-full p-3 rounded-lg bg-kitsuden-surface border border-kitsuden-input text-sm"
          placeholder={t("newsletterView.preheaderWhatIsVisible")}
          bind:value={draftPreview}
        />

        <div class="grid md:grid-cols-2 gap-4">
          <textarea
            class="w-full h-72 font-mono text-sm p-3 rounded-lg bg-kitsuden-surface border border-kitsuden-input"
            placeholder={t("newsletterView.newsletterHtml")}
            bind:value={draftHtml}></textarea>
          <!-- sandbox without allow-scripts: the HTML is content, not code. -->
          <iframe
            class="w-full h-72 rounded-lg border border-kitsuden-border bg-white"
            sandbox=""
            title={t("newsletterView.preview")}
            srcdoc={draftHtml}
          ></iframe>
        </div>

        <div class="flex items-center gap-3">
          <label class="text-sm text-kitsuden-text-dim" for="nl-schedule"
            >{t("newsletterView.scheduleFor")}</label
          >
          <input
            id="nl-schedule"
            type="datetime-local"
            class="p-2 rounded-lg bg-kitsuden-surface border border-kitsuden-input text-sm"
            bind:value={draftScheduledAt}
          />
          <span class="text-xs text-kitsuden-text-dim">
            {t("newsletterView.emptyStaysAsDraftThe")}
          </span>
        </div>

        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm text-kitsuden-text-dim"
            onclick={() => (editorOpen = false)}
          >
            {t("common.cancel")}
          </button>
          <button
            class="px-4 py-2 rounded-lg bg-kitsuden-accent text-kitsuden-on-accent text-sm"
            disabled={saving}
            onclick={saveDraft}
          >
            {saving
              ? t("newsletterView.saving")
              : draftScheduledAt
                ? t("newsletterView.saveAndSchedule")
                : t("newsletterView.saveDraft")}
          </button>
        </div>
      </div>
    {/if}
  </Dialog>

  <!-- ══ Send confirmation ══ -->
  <Dialog
    open={!!confirmSend}
    bare
    ariaLabel={t("newsletterView.confirmSubmit")}
    onClose={() => (confirmSend = null)}
  >
    {#if confirmSend}
      <div class="bg-kitsuden-bg rounded-xl border border-kitsuden-border max-w-md p-6 space-y-4">
        <h2 class="text-lg font-semibold">{t("newsletterView.confirmSubmit")}</h2>
        <p class="text-sm">
          {t("newsletterView.willBeSentTo", { subject: confirmSend.subject })}
          <strong class="text-kitsuden-accent">{confirmSend.recipients}</strong>
          {t("newsletterView.recipients")}
        </p>
        <p class="text-xs text-kitsuden-text-dim">
          {t("newsletterView.thisCannotBeUndone")}
        </p>
        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm text-kitsuden-text-dim"
            onclick={() => (confirmSend = null)}
          >
            {t("common.cancel")}
          </button>
          <button
            class="px-4 py-2 rounded-lg bg-kitsuden-green text-kitsuden-on-status text-sm"
            onclick={doSend}
          >
            {t("newsletterView.sendTo", { recipients: confirmSend.recipients })}
          </button>
        </div>
      </div>
    {/if}
  </Dialog>

  <!-- ══ Stats ══ -->
  <Dialog
    open={!!statsFor}
    bare
    size="lg"
    ariaLabel={t("newsletterView.statistics")}
    onClose={() => (statsFor = null)}
  >
    {#if statsFor}
      <div
        class="bg-kitsuden-bg rounded-xl border border-kitsuden-border max-w-lg w-full p-6 space-y-4"
      >
        <div class="flex justify-between items-center">
          <h2 class="text-lg font-semibold">{t("newsletterView.statistics")}</h2>
          <button
            class="text-kitsuden-text-dim"
            onclick={() => ((statsFor = null), (statsData = null))}
          >
            ×
          </button>
        </div>
        {#if statsData}
          <div class="grid grid-cols-3 gap-3 text-center">
            {#each [["Recipients", statsData.stats.recipients ?? 0], ["Sent", statsData.stats.sent ?? 0], ["Failed", statsData.stats.failed ?? 0], ["Delivered", statsData.stats.delivered ?? 0], ["Bounced", statsData.stats.bounced ?? 0], ["Complaints", statsData.stats.complained ?? 0]] as [label, value] (label)}
              <div class="rounded-lg bg-kitsuden-surface p-3">
                <p class="text-xl font-semibold">{value}</p>
                <p class="text-xs text-kitsuden-text-dim">{label}</p>
              </div>
            {/each}
          </div>
          <div>
            <p class="text-sm text-kitsuden-text-dim mb-1">
              {t("newsletterView.breakdownByDeliveryTheSource")}
            </p>
            {#each statsData.breakdown as row (row.status)}
              <div class="flex justify-between text-sm py-1 border-b border-kitsuden-border/40">
                <span>{row.status}</span><span>{row.count}</span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-sm text-kitsuden-text-dim">{t("common.loadingEllipsis")}</p>
        {/if}
      </div>
    {/if}
  </Dialog>
</ViewPage>
