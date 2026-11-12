<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { Plus, ChevronLeft, ChevronRight, Pencil, Trash2 } from "lucide-svelte";
  import {
    toast,
    Dialog,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Avatar,
    Badge,
    Button,
    Checkbox,
    EmptyState,
    Field,
    Input,
    SearchInput,
    Select,
    Spinner,
    Stat,
    Textarea,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  interface Streamer {
    id: string;
    displayName: string;
    slug: string;
    platform: "twitch" | "youtube" | "kick" | "other";
    channelId: string;
    channelUrl?: string;
    bio?: string;
    avatarId?: string;
    isLive?: boolean;
    viewerCount?: number;
    followerCount?: number;
    currentStreamTitle?: string;
    lastSyncedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  let streamers = $state<Streamer[]>([]);
  let loading = $state(false);
  let totalDocs = $state(0);
  let totalPages = $state(1);
  let page = $state(1);
  const limit = 20;

  let search = $state("");
  let platformFilter = $state<"" | "twitch" | "youtube" | "kick" | "other">("");
  let liveOnly = $state(false);
  let sortBy = $state<"followersDesc" | "viewersDesc" | "nameAsc" | "lastSynced">("followersDesc");

  let selectedIds = $state<Set<string>>(new Set());
  let showModal = $state(false);
  let editingStreamer = $state<Streamer | null>(null);
  let saving = $state(false);
  let deletingId = $state<string | null>(null);

  let form = $state({
    displayName: "",
    slug: "",
    platform: "twitch" as Streamer["platform"],
    channelId: "",
    channelUrl: "",
    bio: "",
  });

  const filteredStreamers = $derived(
    search.trim()
      ? streamers.filter(
          (s) =>
            s.displayName.toLowerCase().includes(search.toLowerCase()) ||
            s.channelId.toLowerCase().includes(search.toLowerCase())
        )
      : streamers
  );

  const selectedCount = $derived(selectedIds.size);

  const allVisibleSelected = $derived(
    filteredStreamers.length > 0 && filteredStreamers.every((s) => selectedIds.has(s.id))
  );

  const stats = $derived({
    total: totalDocs,
    live: streamers.filter((s) => s.isLive).length,
    viewers: streamers.reduce((sum, s) => sum + (s.viewerCount || 0), 0),
    avgFollowers: streamers.length
      ? Math.round(streamers.reduce((sum, s) => sum + (s.followerCount || 0), 0) / streamers.length)
      : 0,
  });

  $effect(() => {
    page;
    platformFilter;
    liveOnly;
    sortBy;
    fetchStreamers();
  });

  $effect(() => {
    if (!editingStreamer && form.displayName) {
      form.slug = slugify(form.displayName);
    }
  });

  async function fetchStreamers() {
    loading = true;
    selectedIds = new Set();
    try {
      const sortMap: Record<string, string> = {
        followersDesc: "-followerCount",
        viewersDesc: "-viewerCount",
        nameAsc: "displayName",
        lastSynced: "-lastSyncedAt",
      };
      const res = await api.getStreamers({
        limit,
        page,
        platform: platformFilter || undefined,
        live: liveOnly || undefined,
        sort: sortMap[sortBy],
      });
      streamers = (res.docs || []) as unknown as Streamer[];
      totalDocs = res.totalDocs || 0;
      totalPages = res.totalPages || 1;
    } catch (err: any) {
      toast.error(err.message || t("streamersView.failedToLoadStreamers"));
    } finally {
      loading = false;
    }
  }

  function slugify(text: string) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function formatNumber(n?: number) {
    if (n == null) return "—";
    return new Intl.NumberFormat(localeFormat(), { notation: "compact" }).format(n);
  }

  function timeAgo(date?: string) {
    if (!date) return "—";
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function avatarUrl(id: string) {
    const base = import.meta.env.VITE_API_URL ?? "";
    return `${base}/api/media/preset/${id}/thumbnail`;
  }

  function platformVariant(p: string): "purple" | "error" | "success" | "default" {
    return p === "twitch"
      ? "purple"
      : p === "youtube"
        ? "error"
        : p === "kick"
          ? "success"
          : "default";
  }

  function openAdd() {
    editingStreamer = null;
    form = {
      displayName: "",
      slug: "",
      platform: "twitch",
      channelId: "",
      channelUrl: "",
      bio: "",
    };
    showModal = true;
  }

  function openEdit(s: Streamer) {
    editingStreamer = s;
    form = {
      displayName: s.displayName,
      slug: s.slug,
      platform: s.platform,
      channelId: s.channelId,
      channelUrl: s.channelUrl || "",
      bio: s.bio || "",
    };
    showModal = true;
  }

  function closeModal() {
    showModal = false;
    editingStreamer = null;
  }

  async function saveStreamer() {
    if (!form.displayName.trim() || !form.slug.trim() || !form.channelId.trim()) {
      toast.error(t("streamersView.pleaseFillInRequiredFields"));
      return;
    }
    saving = true;
    try {
      const payload = { ...form };
      if (editingStreamer) {
        await api.updateStreamer(editingStreamer.id, payload as any);
        toast.success(t("streamersView.streamerUpdated"));
      } else {
        await api.createStreamer(payload as any);
        toast.success(t("streamersView.streamerCreated"));
      }
      closeModal();
      fetchStreamers();
    } catch (err: any) {
      toast.error(err.message || t("streamersView.failedToSaveStreamer"));
    } finally {
      saving = false;
    }
  }

  async function deleteStreamer(id: string) {
    if (!(await confirmDialog(t("streamersView.deleteThisStreamer")))) return;
    deletingId = id;
    try {
      await api.deleteStreamer(id);
      toast.success(t("streamersView.streamerDeleted"));
      const next = new Set(selectedIds);
      next.delete(id);
      selectedIds = next;
      fetchStreamers();
    } catch (err: any) {
      toast.error(err.message || t("streamersView.failedToDeleteStreamer"));
    } finally {
      deletingId = null;
    }
  }

  async function deleteSelected() {
    if (!(await confirmDialog(t("streamersView.deleteSelectedStreamers", { selectedCount }))))
      return;
    try {
      await Promise.all([...selectedIds].map((id) => api.deleteStreamer(id)));
      toast.success(t("streamersView.streamersDeleted", { selectedCount }));
      selectedIds = new Set();
      fetchStreamers();
    } catch (err: any) {
      toast.error(err.message || t("streamersView.failedToDeleteStreamers"));
    }
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
  }

  function toggleSelectAll() {
    const next = new Set(selectedIds);
    if (allVisibleSelected) {
      filteredStreamers.forEach((s) => next.delete(s.id));
    } else {
      filteredStreamers.forEach((s) => next.add(s.id));
    }
    selectedIds = next;
  }
</script>

<ViewPage
  title={t("common.streamers")}
  description={t("streamersView.managePartneredContentCreators")}
>
  {#snippet actions()}
    <Button onclick={openAdd}>
      <Plus class="w-4 h-4" />
      {t("streamersView.addStreamer")}
    </Button>
  {/snippet}

  <div class="space-y-6">
    <!-- Stats -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <Stat label={t("streamersView.totalStreamers")} value={stats.total} />
      <Stat
        label={t("streamersView.liveNow")}
        value={stats.live}
        variant={stats.live > 0 ? "success" : "default"}
      />
      <Stat label={t("streamersView.totalViewers")} value={formatNumber(stats.viewers)} />
      <Stat label={t("streamersView.avgFollowers")} value={formatNumber(stats.avgFollowers)} />
    </div>

    <!-- Controls -->
    <div class="space-y-3">
      <div class="flex flex-col lg:flex-row gap-3">
        <SearchInput
          class="flex-1 min-w-0"
          bind:value={search}
          placeholder={t("streamersView.searchByNameOrChannel")}
        />
        <div class="flex flex-wrap items-center gap-3">
          <Select
            width="auto"
            aria-label={t("common.platform")}
            value={platformFilter}
            onchange={(e: Event) =>
              (platformFilter = (e.currentTarget as HTMLSelectElement)
                .value as typeof platformFilter)}
            options={[
              { value: "", label: t("streamersView.allPlatforms") },
              { value: "twitch", label: t("streamersView.twitch") },
              { value: "youtube", label: t("streamersView.youtube") },
              { value: "kick", label: t("streamersView.kick") },
              { value: "other", label: t("streamersView.other") },
            ]}
          />
          <Checkbox bind:checked={liveOnly} label={t("streamersView.liveOnly")} />
          <Select
            width="auto"
            aria-label={t("streamersView.sortBy")}
            value={sortBy}
            onchange={(e: Event) =>
              (sortBy = (e.currentTarget as HTMLSelectElement).value as typeof sortBy)}
            options={[
              { value: "followersDesc", label: t("streamersView.followers") },
              { value: "viewersDesc", label: t("streamersView.viewers") },
              { value: "nameAsc", label: t("streamersView.nameAZ") },
              { value: "lastSynced", label: t("streamersView.lastSynced") },
            ]}
          />
        </div>
      </div>

      <!-- Bulk bar -->
      {#if selectedCount > 0}
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm text-kitsuden-text font-medium"
            >{selectedCount} {t("common.selected")}</span
          >
          <Button variant="danger-ghost" size="sm" onclick={deleteSelected}>
            <Trash2 class="w-4 h-4" />
            {t("streamersView.deleteSelected")}
          </Button>
        </div>
      {/if}

      <!-- Table -->
      {#if loading}
        <div class="flex justify-center py-20">
          <Spinner />
        </div>
      {:else if filteredStreamers.length === 0}
        <EmptyState
          title={t("streamersView.noStreamersFound")}
          description={t("streamersView.tryAdjustingYourFiltersOr")}
        />
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10">
                <Checkbox
                  ariaLabel={t("streamersView.selectAll")}
                  checked={allVisibleSelected}
                  onchange={toggleSelectAll}
                />
              </TableHead>
              <TableHead class="w-12">{t("streamersView.avatar")}</TableHead>
              <TableHead>{t("streamersView.displayName")}</TableHead>
              <TableHead>{t("common.platform")}</TableHead>
              <TableHead>{t("streamersView.channelId")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
              <TableHead class="text-right">{t("streamersView.viewers2")}</TableHead>
              <TableHead class="text-right">{t("streamersView.followers2")}</TableHead>
              <TableHead>{t("streamersView.lastSynced")}</TableHead>
              <TableHead class="text-right">{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each filteredStreamers as s (s.id)}
              <TableRow>
                <TableCell>
                  <Checkbox
                    ariaLabel={t("streamersView.selectStreamer", { name: s.displayName })}
                    checked={selectedIds.has(s.id)}
                    onchange={() => toggleSelect(s.id)}
                  />
                </TableCell>
                <TableCell>
                  <Avatar
                    name={s.displayName}
                    src={s.avatarId ? avatarUrl(s.avatarId) : null}
                    size="sm"
                    initials={1}
                  />
                </TableCell>
                <TableCell>
                  {#if s.channelUrl}
                    <a
                      href={s.channelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-medium text-kitsuden-text hover:text-kitsuden-accent transition-colors"
                    >
                      {s.displayName}
                    </a>
                  {:else}
                    <span class="font-medium text-kitsuden-text">{s.displayName}</span>
                  {/if}
                  {#if s.currentStreamTitle}
                    <p class="text-[11px] text-kitsuden-subtle truncate max-w-[200px]">
                      {s.currentStreamTitle}
                    </p>
                  {/if}
                </TableCell>
                <TableCell>
                  <Badge variant={platformVariant(s.platform)}>{s.platform}</Badge>
                </TableCell>
                <TableCell class="text-kitsuden-subtle font-mono text-xs">{s.channelId}</TableCell>
                <TableCell>
                  {#if s.isLive}
                    <Badge variant="accent-2" pulse>{t("streamersView.live")}</Badge>
                  {:else}
                    <Badge>{t("streamersView.offline")}</Badge>
                  {/if}
                </TableCell>
                <TableCell class="text-right text-kitsuden-text"
                  >{formatNumber(s.viewerCount)}</TableCell
                >
                <TableCell class="text-right text-kitsuden-text"
                  >{formatNumber(s.followerCount)}</TableCell
                >
                <TableCell class="text-kitsuden-subtle text-xs">{timeAgo(s.lastSyncedAt)}</TableCell
                >
                <TableCell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onclick={() => openEdit(s)}
                      title={t("common.edit")}
                      ariaLabel={t("common.edit")}
                    >
                      <Pencil class="w-4 h-4" />
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      onclick={() => deleteStreamer(s.id)}
                      loading={deletingId === s.id}
                      disabled={deletingId === s.id}
                      title={t("common.delete")}
                      ariaLabel={t("common.delete")}
                    >
                      {#if deletingId !== s.id}<Trash2 class="w-4 h-4" />{/if}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>

        <!-- Pagination -->
        <div class="flex items-center justify-between gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onclick={() => page--}>
            <ChevronLeft class="w-4 h-4" />
            {t("streamersView.prev")}
          </Button>
          <span class="text-sm text-kitsuden-subtle"
            >{t("streamersView.pageOf", { page })} {totalPages}</span
          >
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onclick={() => page++}
          >
            {t("common.next")}
            <ChevronRight class="w-4 h-4" />
          </Button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Modal -->
  <Dialog
    open={!!showModal}
    size="lg"
    title={editingStreamer ? t("streamersView.editStreamer") : t("streamersView.addStreamer")}
    onClose={() => closeModal()}
  >
    {#if showModal}
      <div class="space-y-4">
        <Field label={t("streamersView.displayName2")}>
          <Input id="displayname" bind:value={form.displayName} />
        </Field>
        <Field label={t("streamersView.slug")}>
          <Input id="slug" bind:value={form.slug} />
        </Field>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t("streamersView.platform")}>
            <Select
              id="platform"
              value={form.platform}
              onchange={(e: Event) =>
                (form.platform = (e.currentTarget as HTMLSelectElement)
                  .value as Streamer["platform"])}
              options={[
                { value: "twitch", label: t("streamersView.twitch") },
                { value: "youtube", label: t("streamersView.youtube") },
                { value: "kick", label: t("streamersView.kick") },
                { value: "other", label: t("streamersView.other") },
              ]}
            />
          </Field>
          <Field label={t("streamersView.channelId2")}>
            <Input id="channelid" bind:value={form.channelId} />
          </Field>
        </div>
        <Field label={t("streamersView.channelUrl")}>
          <Input id="channelurl" bind:value={form.channelUrl} placeholder="https://twitch.tv/..." />
        </Field>
        <Field label={t("streamersView.bio")}>
          <Textarea id="bio" bind:value={form.bio} rows={3} />
        </Field>
      </div>
    {/if}
    {#snippet footer()}
      <Button variant="secondary" onclick={closeModal}>{t("common.cancel")}</Button>
      <Button onclick={saveStreamer} loading={saving} disabled={saving}>
        {t("streamersView.save")}
      </Button>
    {/snippet}
  </Dialog>
</ViewPage>
