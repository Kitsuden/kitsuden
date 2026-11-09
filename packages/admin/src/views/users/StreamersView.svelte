<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import {
    Tv,
    Users,
    Radio,
    Eye,
    TrendingUp,
    Plus,
    Search,
    ChevronLeft,
    ChevronRight,
    Pencil,
    Trash2,
    X,
    Loader2,
  } from "lucide-svelte";
  import { toast } from "svelte-sonner";

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

  function platformClasses(p: string) {
    switch (p) {
      case "twitch":
        return "bg-purple-500/10 text-purple-400 border-purple-500/20";
      case "youtube":
        return "bg-red-500/10 text-red-400 border-red-500/20";
      case "kick":
        return "bg-green-500/10 text-green-400 border-green-500/20";
      default:
        return "bg-gray-500/10 text-gray-400 border-gray-500/20";
    }
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
    if (!confirm(t("streamersView.deleteThisStreamer"))) return;
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
    if (!confirm(t("streamersView.deleteSelectedStreamers", { selectedCount }))) return;
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

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-2">
        <Tv class="w-6 h-6 text-kitsuden-accent" />
        {t("common.streamers")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-0.5">
        {t("streamersView.managePartneredContentCreators")}
      </p>
    </div>
    <button class="btn-primary inline-flex items-center gap-2" onclick={openAdd}>
      <Plus class="w-4 h-4" />
      {t("streamersView.addStreamer")}
    </button>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
    <div class="card p-4 flex items-center gap-4">
      <div class="w-10 h-10 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center">
        <Users class="w-5 h-5 text-kitsuden-accent" />
      </div>
      <div>
        <p class="text-2xl font-bold text-kitsuden-text">{stats.total}</p>
        <p class="text-xs text-kitsuden-subtle">{t("streamersView.totalStreamers")}</p>
      </div>
    </div>
    <div class="card p-4 flex items-center gap-4">
      <div
        class="w-10 h-10 rounded-lg bg-kitsuden-accent-2/10 flex items-center justify-center animate-pulse"
      >
        <Radio class="w-5 h-5 text-kitsuden-accent-2" />
      </div>
      <div>
        <p class="text-2xl font-bold text-kitsuden-text">{stats.live}</p>
        <p class="text-xs text-kitsuden-subtle">{t("streamersView.liveNow")}</p>
      </div>
    </div>
    <div class="card p-4 flex items-center gap-4">
      <div class="w-10 h-10 rounded-lg bg-kitsuden-green/10 flex items-center justify-center">
        <Eye class="w-5 h-5 text-kitsuden-green" />
      </div>
      <div>
        <p class="text-2xl font-bold text-kitsuden-text">{formatNumber(stats.viewers)}</p>
        <p class="text-xs text-kitsuden-subtle">{t("streamersView.totalViewers")}</p>
      </div>
    </div>
    <div class="card p-4 flex items-center gap-4">
      <div class="w-10 h-10 rounded-lg bg-kitsuden-amber/10 flex items-center justify-center">
        <TrendingUp class="w-5 h-5 text-kitsuden-amber" />
      </div>
      <div>
        <p class="text-2xl font-bold text-kitsuden-text">{formatNumber(stats.avgFollowers)}</p>
        <p class="text-xs text-kitsuden-subtle">{t("streamersView.avgFollowers")}</p>
      </div>
    </div>
  </div>

  <!-- Controls -->
  <div class="card overflow-hidden">
    <div class="flex flex-col lg:flex-row gap-3 p-4 border-b border-kitsuden-border">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle" />
        <input
          bind:value={search}
          placeholder={t("streamersView.searchByNameOrChannel")}
          class="w-full pl-9 pr-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-none focus:border-kitsuden-accent"
        />
      </div>
      <div class="flex flex-wrap gap-3">
        <select
          bind:value={platformFilter}
          class="px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
        >
          <option value="">{t("streamersView.allPlatforms")}</option>
          <option value="twitch">{t("streamersView.twitch")}</option>
          <option value="youtube">{t("streamersView.youtube")}</option>
          <option value="kick">{t("streamersView.kick")}</option>
          <option value="other">{t("streamersView.other")}</option>
        </select>
        <label
          for="sortby"
          class="flex items-center gap-2 px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text cursor-pointer select-none"
        >
          <input type="checkbox" bind:checked={liveOnly} class="accent-kitsuden-accent-2" />
          {t("streamersView.liveOnly")}
        </label>
        <select
          id="sortby"
          bind:value={sortBy}
          class="px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
        >
          <option value="followersDesc">{t("streamersView.followers")}</option>
          <option value="viewersDesc">{t("streamersView.viewers")}</option>
          <option value="nameAsc">{t("streamersView.nameAZ")}</option>
          <option value="lastSynced">{t("streamersView.lastSynced")}</option>
        </select>
      </div>
    </div>

    <!-- Bulk bar -->
    {#if selectedCount > 0}
      <div
        class="flex items-center justify-between px-4 py-2 bg-kitsuden-surface border-b border-kitsuden-border animate-fade-in"
      >
        <span class="text-sm text-kitsuden-text font-medium"
          >{selectedCount} {t("common.selected")}</span
        >
        <button
          class="btn-ghost text-kitsuden-accent-2 inline-flex items-center gap-1.5 text-sm"
          onclick={deleteSelected}
        >
          <Trash2 class="w-4 h-4" />
          {t("streamersView.deleteSelected")}
        </button>
      </div>
    {/if}

    <!-- Table -->
    {#if loading}
      <div class="flex justify-center py-20">
        <Loader2 class="w-6 h-6 animate-spin text-kitsuden-accent" />
      </div>
    {:else if filteredStreamers.length === 0}
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <Tv class="w-12 h-12 text-kitsuden-subtle mb-3" />
        <p class="text-kitsuden-text-dim font-medium">{t("streamersView.noStreamersFound")}</p>
        <p class="text-xs text-kitsuden-subtle mt-1">
          {t("streamersView.tryAdjustingYourFiltersOr")}
        </p>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left">
          <thead
            class="text-xs text-kitsuden-subtle uppercase bg-kitsuden-surface border-b border-kitsuden-border"
          >
            <tr>
              <th class="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onchange={toggleSelectAll}
                  class="accent-kitsuden-accent"
                />
              </th>
              <th class="px-4 py-3 w-12">{t("streamersView.avatar")}</th>
              <th class="px-4 py-3">{t("streamersView.displayName")}</th>
              <th class="px-4 py-3">{t("common.platform")}</th>
              <th class="px-4 py-3">{t("streamersView.channelId")}</th>
              <th class="px-4 py-3">{t("common.status")}</th>
              <th class="px-4 py-3 text-right">{t("streamersView.viewers2")}</th>
              <th class="px-4 py-3 text-right">{t("streamersView.followers2")}</th>
              <th class="px-4 py-3">{t("streamersView.lastSynced")}</th>
              <th class="px-4 py-3 text-right">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredStreamers as s (s.id)}
              <tr
                class="border-b border-kitsuden-border hover:bg-kitsuden-surface/40 transition-colors"
              >
                <td class="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onchange={() => toggleSelect(s.id)}
                    class="accent-kitsuden-accent"
                  />
                </td>
                <td class="px-4 py-3">
                  {#if s.avatarId}
                    <img
                      src={avatarUrl(s.avatarId)}
                      alt={s.displayName}
                      class="w-8 h-8 rounded-full object-cover bg-kitsuden-surface"
                      loading="lazy"
                    />
                  {:else}
                    <div
                      class="w-8 h-8 rounded-full bg-kitsuden-surface flex items-center justify-center text-[10px] text-kitsuden-subtle font-bold"
                    >
                      {s.displayName.charAt(0).toUpperCase()}
                    </div>
                  {/if}
                </td>
                <td class="px-4 py-3">
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
                </td>
                <td class="px-4 py-3">
                  <span
                    class="inline-block px-2 py-0.5 text-[10px] font-medium rounded-full border {platformClasses(
                      s.platform
                    )}"
                  >
                    {s.platform}
                  </span>
                </td>
                <td class="px-4 py-3 text-kitsuden-subtle font-mono text-xs">{s.channelId}</td>
                <td class="px-4 py-3">
                  {#if s.isLive}
                    <span
                      class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium bg-kitsuden-accent-2/10 text-kitsuden-accent-2 rounded-full border border-kitsuden-accent-2/20"
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-kitsuden-accent-2 animate-pulse"
                      ></span>
                      {t("streamersView.live")}
                    </span>
                  {:else}
                    <span
                      class="px-2 py-0.5 text-[10px] font-medium bg-kitsuden-surface text-kitsuden-subtle rounded-full border border-kitsuden-border"
                    >
                      {t("streamersView.offline")}
                    </span>
                  {/if}
                </td>
                <td class="px-4 py-3 text-right text-kitsuden-text"
                  >{formatNumber(s.viewerCount)}</td
                >
                <td class="px-4 py-3 text-right text-kitsuden-text"
                  >{formatNumber(s.followerCount)}</td
                >
                <td class="px-4 py-3 text-kitsuden-subtle text-xs">{timeAgo(s.lastSyncedAt)}</td>
                <td class="px-4 py-3 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      class="btn-ghost p-1.5"
                      onclick={() => openEdit(s)}
                      title={t("common.edit")}
                    >
                      <Pencil class="w-4 h-4" />
                    </button>
                    <button
                      class="btn-ghost p-1.5 text-kitsuden-accent-2"
                      onclick={() => deleteStreamer(s.id)}
                      disabled={deletingId === s.id}
                      title={t("common.delete")}
                    >
                      {#if deletingId === s.id}
                        <Loader2 class="w-4 h-4 animate-spin" />
                      {:else}
                        <Trash2 class="w-4 h-4" />
                      {/if}
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-between px-4 py-3 border-t border-kitsuden-border">
        <button
          class="btn-secondary inline-flex items-center gap-1 text-sm"
          disabled={page <= 1}
          onclick={() => page--}
        >
          <ChevronLeft class="w-4 h-4" />
          {t("streamersView.prev")}
        </button>
        <span class="text-sm text-kitsuden-subtle"
          >{t("streamersView.pageOf", { page })} {totalPages}</span
        >
        <button
          class="btn-secondary inline-flex items-center gap-1 text-sm"
          disabled={page >= totalPages}
          onclick={() => page++}
        >
          {t("common.next")}
          <ChevronRight class="w-4 h-4" />
        </button>
      </div>
    {/if}
  </div>
</div>

<!-- Modal -->
{#if showModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
    <div class="card w-full max-w-lg max-h-[90vh] overflow-y-auto animate-fade-in">
      <div class="flex items-center justify-between p-4 border-b border-kitsuden-border">
        <h3 class="text-lg font-semibold text-kitsuden-text">
          {editingStreamer ? t("streamersView.editStreamer") : t("streamersView.addStreamer")}
        </h3>
        <button class="btn-ghost p-1" onclick={closeModal}>
          <X class="w-4 h-4" />
        </button>
      </div>
      <div class="p-4 space-y-4">
        <div>
          <label for="displayname" class="block text-xs font-medium text-kitsuden-subtle mb-1"
            >{t("streamersView.displayName2")}</label
          >
          <input
            id="displayname"
            bind:value={form.displayName}
            class="w-full px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
          />
        </div>
        <div>
          <label for="slug" class="block text-xs font-medium text-kitsuden-subtle mb-1"
            >{t("streamersView.slug")}</label
          >
          <input
            id="slug"
            bind:value={form.slug}
            class="w-full px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
          />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="platform" class="block text-xs font-medium text-kitsuden-subtle mb-1"
              >{t("streamersView.platform")}</label
            >
            <select
              id="platform"
              bind:value={form.platform}
              class="w-full px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
            >
              <option value="twitch">{t("streamersView.twitch")}</option>
              <option value="youtube">{t("streamersView.youtube")}</option>
              <option value="kick">{t("streamersView.kick")}</option>
              <option value="other">{t("streamersView.other")}</option>
            </select>
          </div>
          <div>
            <label for="channelid" class="block text-xs font-medium text-kitsuden-subtle mb-1"
              >{t("streamersView.channelId2")}</label
            >
            <input
              id="channelid"
              bind:value={form.channelId}
              class="w-full px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
            />
          </div>
        </div>
        <div>
          <label for="channelurl" class="block text-xs font-medium text-kitsuden-subtle mb-1"
            >{t("streamersView.channelUrl")}</label
          >
          <input
            id="channelurl"
            bind:value={form.channelUrl}
            placeholder="https://twitch.tv/..."
            class="w-full px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-none focus:border-kitsuden-accent"
          />
        </div>
        <div>
          <label for="bio" class="block text-xs font-medium text-kitsuden-subtle mb-1"
            >{t("streamersView.bio")}</label
          >
          <textarea
            id="bio"
            bind:value={form.bio}
            rows={3}
            class="w-full px-3 py-2 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-none focus:border-kitsuden-accent resize-none"
          ></textarea>
        </div>
      </div>
      <div class="flex justify-end gap-2 p-4 border-t border-kitsuden-border">
        <button class="btn-secondary" onclick={closeModal}>{t("common.cancel")}</button>
        <button
          class="btn-primary inline-flex items-center gap-2"
          onclick={saveStreamer}
          disabled={saving}
        >
          {#if saving}
            <Loader2 class="w-4 h-4 animate-spin" />
          {/if}
          {t("streamersView.save")}
        </button>
      </div>
    </div>
  </div>
{/if}
