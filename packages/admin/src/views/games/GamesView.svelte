<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    Gamepad2,
    CheckCircle,
    FileEdit,
    Layers,
    Search,
    Plus,
    ChevronLeft,
    ChevronRight,
    Pencil,
    Trash2,
    Loader2,
    Star,
    PackageOpen,
    Monitor,
    Tag,
    Save,
    X,
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
  } from "lucide-svelte";
  import { onMount, untrack } from "svelte";
  import {
    toast,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Button,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  interface Game {
    id: string;
    title: string;
    slug: string;
    status: "draft" | "published" | "archived";
    developer?: string;
    publisher?: string;
    releaseDate?: string;
    metacriticScore?: number;
    userRating?: number;
    isFeaturedOnHome?: boolean;
    coverArtId?: string;
  }
  /**
   * ── THE FIELD IS CALLED `title`, NOT `name` ──────────────────────────────
   *
   * The database column is `title` and the endpoint reads `body.title`. Here
   * `name` was being sent, so creating a collection sent `title: undefined`
   * against a `NOT NULL` column and the request blew up: "Create failed".
   *
   * And in the other direction the same: `GET /collections` returns `title` and this
   * interface read `name`, so existing collections came out with a
   * blank name.
   *
   * It is the same failure as `tags` versus `tagIds` in the blog. The field name
   * IS the contract, and getting it wrong gives no type error: it gives a 500 on
   * one side and an empty gap on the other.
   */
  interface Collection {
    id: string;
    title: string;
    slug: string;
    displayOrder?: number;
    games?: any[];
  }
  interface Platform {
    id: string;
    name: string;
    slug: string;
    manufacturer?: string;
    shortName?: string;
  }
  interface TagItem {
    id: string;
    name: string;
    slug: string;
    color?: string;
    category?: string;
  }

  type Tab = "games" | "collections" | "platforms" | "tags";

  /**
   * Which view of the kon was clicked in the top bar.
   *
   * This component is registered for TWO views —"All Games" and
   * "Collections"— and has its own tabs inside. Without this it always opened
   * on "games", so clicking "Collections" showed the games list: the
   * tab was highlighted, the content was something else and nothing failed.
   *
   * It is optional because the component is also used from routes that pass
   * nothing; in that case it behaves as always.
   */
  const { viewId }: { viewId?: string } = $props();

  /** `kon-games-collections`, `collections`, `grimoire-games-collections`… */
  function tabOf(id: string | undefined): Tab {
    if (!id) return "games";
    for (const p of ["collections", "platforms", "tags"] as const) {
      if (id.endsWith(p)) return p;
    }
    return "games";
  }

  // `untrack` at initialization: capturing the initial value here is
  // DELIBERATE —the $effect below takes care of changes— and saying so
  // explicitly keeps it from looking like the oversight Svelte warns about.
  let activeTab = $state<Tab>(untrack(() => tabOf(viewId)));

  /**
   * And if the view is switched without remounting the component, the tab follows.
   *
   * The panel's router REUSES the component when navigating between views of the
   * same kon, so a value computed only at initialization sticks with the
   * first one — the same failure that left the explorer's tabs without reloading.
   *
   * `untrack` on the write: `activeTab` is also changed by whoever clicks the
   * inner tabs, and reading it here would create a loop that would undo their click.
   */
  let lastAppliedView = $state<string | undefined>(undefined);
  $effect(() => {
    const id = viewId;
    if (id === lastAppliedView) return;
    lastAppliedView = id;
    untrack(() => {
      activeTab = tabOf(id);
    });
  });

  // Games
  let games = $state<Game[]>([]),
    gamesLoading = $state(true),
    gamesPage = $state(1),
    gamesLimit = $state(15);
  let gamesTotal = $state(0),
    gamesTotalPages = $state(1),
    gamesSearch = $state(""),
    gamesStatus = $state("");
  let gamesSort = $state<{ field: keyof Game; dir: "asc" | "desc" }>({
    field: "title",
    dir: "asc",
  });
  let selectedGameIds = $state<Set<string>>(new Set());

  // Collections
  let collections = $state<Collection[]>([]),
    collectionsLoading = $state(true);
  let newCollectionName = $state(""),
    newCollectionSlug = $state("");
  let editingCollectionId = $state<string | null>(null);
  let editCollectionName = $state(""),
    editCollectionSlug = $state(""),
    editCollectionOrder = $state(0);

  // Platforms
  let platforms = $state<Platform[]>([]),
    platformsLoading = $state(true);
  let newPlatformName = $state(""),
    newPlatformSlug = $state(""),
    newPlatformManufacturer = $state(""),
    newPlatformShort = $state("");

  // Tags
  let tags = $state<TagItem[]>([]),
    tagsLoading = $state(true);
  let newTagName = $state(""),
    newTagSlug = $state(""),
    newTagColor = $state(""),
    newTagCategory = $state("");

  // Stats
  let statsLoading = $state(true),
    totalGames = $state(0),
    publishedGames = $state(0),
    draftGames = $state(0),
    totalCollections = $state(0);

  const sortedGames = $derived(() => {
    const s = [...games];
    const { field, dir } = gamesSort;
    s.sort((a, b) => {
      const av = a[field] ?? "",
        bv = b[field] ?? "";
      return av < bv ? (dir === "asc" ? -1 : 1) : av > bv ? (dir === "asc" ? 1 : -1) : 0;
    });
    return s;
  });

  async function loadGames() {
    gamesLoading = true;
    try {
      const res = await api.getGames({
        limit: gamesLimit,
        page: gamesPage,
        search: gamesSearch || undefined,
        status: gamesStatus || undefined,
      });
      games = res.docs as Game[];
      gamesTotal = res.totalDocs;
      gamesTotalPages = res.totalPages;
      selectedGameIds = new Set();
    } catch (e: any) {
      toast.error(tr("gamesView.failedToLoadGames") + (e.message || tr("gamesView.unknownError")));
    } finally {
      gamesLoading = false;
    }
  }
  async function loadCollections() {
    collectionsLoading = true;
    try {
      const res = await api.getGameCollections();
      collections = (res.docs as Collection[]) || [];
      totalCollections = res.totalDocs ?? collections.length;
    } catch (e: any) {
      toast.error(
        tr("gamesView.failedToLoadCollections") + (e.message || tr("gamesView.unknownError"))
      );
    } finally {
      collectionsLoading = false;
    }
  }
  async function loadPlatforms() {
    platformsLoading = true;
    try {
      const res = await api.getPlatforms();
      platforms = (res.docs as Platform[]) || [];
    } catch (e: any) {
      toast.error(
        tr("gamesView.failedToLoadPlatforms") + (e.message || tr("gamesView.unknownError"))
      );
    } finally {
      platformsLoading = false;
    }
  }
  async function loadTags() {
    tagsLoading = true;
    try {
      const res = await api.getTags();
      tags = (res.docs as TagItem[]) || [];
    } catch (e: any) {
      toast.error(tr("gamesView.failedToLoadTags") + (e.message || tr("gamesView.unknownError")));
    } finally {
      tagsLoading = false;
    }
  }
  async function loadStats() {
    statsLoading = true;
    try {
      const [all, pub, draft, colls] = await Promise.all([
        api.getGames({ limit: 1 }),
        api.getGames({ limit: 1, status: "published" }),
        api.getGames({ limit: 1, status: "draft" }),
        api.getGameCollections(),
      ]);
      totalGames = all.totalDocs;
      publishedGames = pub.totalDocs;
      draftGames = draft.totalDocs;
      totalCollections = colls.totalDocs ?? 0;
    } catch (e: any) {
      toast.error(tr("gamesView.failedToLoadStats") + (e.message || tr("gamesView.unknownError")));
    } finally {
      statsLoading = false;
    }
  }

  onMount(() => {
    loadStats();
    loadGames();
    loadCollections();
    loadPlatforms();
    loadTags();
  });

  async function deleteGame(id: string) {
    if (!(await confirmDialog(tr("gamesView.deleteThisGame")))) return;
    try {
      await api.deleteGame(id);
      toast.success(tr("gamesView.gameDeleted"));
      await loadGames();
      await loadStats();
    } catch (e: any) {
      toast.error(tr("gamesView.deleteFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }
  async function bulkDeleteGames() {
    const ids = Array.from(selectedGameIds);
    if (
      !ids.length ||
      !(await confirmDialog(tr("gamesView.deleteGames", { idsCount: ids.length })))
    )
      return;
    try {
      await Promise.all(ids.map((id) => api.deleteGame(id)));
      toast.success(tr("gamesView.gamesDeleted", { idsCount: ids.length }));
      await loadGames();
      await loadStats();
    } catch (e: any) {
      toast.error(tr("gamesView.bulkDeleteFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }
  async function toggleFeatured(game: Game) {
    try {
      await api.updateGame(game.id, { isFeaturedOnHome: !game.isFeaturedOnHome } as any);
      game.isFeaturedOnHome = !game.isFeaturedOnHome;
      toast.success(game.isFeaturedOnHome ? tr("gamesView.featured") : tr("gamesView.unfeatured"));
    } catch (e: any) {
      toast.error(tr("gamesView.updateFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }
  async function bulkToggleFeatured() {
    const ids = Array.from(selectedGameIds);
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => api.updateGame(id, { isFeaturedOnHome: true } as any)));
      toast.success(tr("gamesView.gamesFeatured", { idsCount: ids.length }));
      await loadGames();
    } catch (e: any) {
      toast.error(tr("gamesView.bulkUpdateFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }

  async function createCollection() {
    if (!newCollectionName.trim() || !newCollectionSlug.trim()) {
      toast.error(tr("gamesView.nameAndSlugRequired"));
      return;
    }
    try {
      await api.createGameCollection({
        title: newCollectionName.trim(),
        slug: newCollectionSlug.trim(),
      } as any);
      toast.success(tr("gamesView.collectionCreated"));
      newCollectionName = "";
      newCollectionSlug = "";
      await loadCollections();
      await loadStats();
    } catch (e: any) {
      toast.error(tr("gamesView.createFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }
  async function updateCollection(c: Collection) {
    try {
      await api.updateGameCollection(c.id, {
        title: editCollectionName,
        slug: editCollectionSlug,
        displayOrder: editCollectionOrder,
      } as any);
      toast.success(tr("gamesView.collectionUpdated"));
      editingCollectionId = null;
      await loadCollections();
    } catch (e: any) {
      toast.error(tr("gamesView.updateFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }
  async function deleteCollection(id: string) {
    if (!(await confirmDialog(tr("gamesView.deleteThisCollection")))) return;
    try {
      await api.deleteGameCollection(id);
      toast.success(tr("gamesView.collectionDeleted"));
      await loadCollections();
      await loadStats();
    } catch (e: any) {
      toast.error(tr("gamesView.deleteFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }

  async function createPlatform() {
    if (!newPlatformName.trim() || !newPlatformSlug.trim()) {
      toast.error(tr("gamesView.nameAndSlugRequired"));
      return;
    }
    try {
      await api.createPlatform({
        name: newPlatformName.trim(),
        slug: newPlatformSlug.trim(),
        manufacturer: newPlatformManufacturer || undefined,
        shortName: newPlatformShort || undefined,
      } as any);
      toast.success(tr("gamesView.platformCreated"));
      newPlatformName = "";
      newPlatformSlug = "";
      newPlatformManufacturer = "";
      newPlatformShort = "";
      await loadPlatforms();
    } catch (e: any) {
      toast.error(tr("gamesView.createFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }
  async function createTag() {
    if (!newTagName.trim() || !newTagSlug.trim()) {
      toast.error(tr("gamesView.nameAndSlugRequired"));
      return;
    }
    try {
      await api.createTag({
        name: newTagName.trim(),
        slug: newTagSlug.trim(),
        color: newTagColor || undefined,
        category: newTagCategory || undefined,
      } as any);
      toast.success(tr("gamesView.tagCreated"));
      newTagName = "";
      newTagSlug = "";
      newTagColor = "";
      newTagCategory = "";
      await loadTags();
    } catch (e: any) {
      toast.error(tr("gamesView.createFailed") + (e.message || tr("gamesView.unknownError")));
    }
  }

  function statusClasses(status: string) {
    return status === "published"
      ? "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20"
      : status === "draft"
        ? "bg-kitsuden-amber/10 text-kitsuden-amber border-kitsuden-amber/20"
        : status === "archived"
          ? "bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border-kitsuden-accent-2/20"
          : "bg-kitsuden-muted/20 text-kitsuden-text-dim border-kitsuden-border";
  }
  function metacriticClass(s?: number) {
    return s == null
      ? "bg-kitsuden-muted/20 text-kitsuden-text-dim"
      : s >= 75
        ? "bg-kitsuden-green/10 text-kitsuden-green"
        : s >= 50
          ? "bg-kitsuden-amber/10 text-kitsuden-amber"
          : "bg-kitsuden-accent-2/10 text-kitsuden-accent-2";
  }
  function formatDate(d?: string) {
    return d ? new Date(d).toLocaleDateString(localeFormat()) : "-";
  }
  function toggleSort(f: keyof Game) {
    gamesSort =
      gamesSort.field === f
        ? { field: f, dir: gamesSort.dir === "asc" ? "desc" : "asc" }
        : { field: f, dir: "asc" };
  }
  function toggleSelection(id: string) {
    const n = new Set(selectedGameIds);
    n.has(id) ? n.delete(id) : n.add(id);
    selectedGameIds = n;
  }
  function toggleAll() {
    selectedGameIds =
      selectedGameIds.size === games.length && games.length > 0
        ? new Set()
        : new Set(games.map((g) => g.id));
  }
  function slugify(v: string) {
    return v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
  function onCollName(v: string) {
    newCollectionName = v;
    if (!newCollectionSlug) newCollectionSlug = slugify(v);
  }
  function onPlatName(v: string) {
    newPlatformName = v;
    if (!newPlatformSlug) newPlatformSlug = slugify(v);
  }
  function onTagName(v: string) {
    newTagName = v;
    if (!newTagSlug) newTagSlug = slugify(v);
  }
  function startEditColl(c: Collection) {
    editingCollectionId = c.id;
    editCollectionName = c.title;
    editCollectionSlug = c.slug;
    editCollectionOrder = c.displayOrder ?? 0;
  }
</script>

<ViewPage
  title={tr("gamesView.gameLibrary")}
  description={tr("gamesView.manageGamesCollectionsPlatformsTags")}
>
  {#snippet actions()}
    <!--
      Before, this led to a bare `/g/kon-games`: you navigated to the kon's screen
      and that was it. No form, no notice — from the outside, a
      button that does nothing.

      `?crear=1` really opens it: the explorer reads that parameter on mount,
      opens the create form and cleans it from the URL so reloading does not repeat it.
    -->
    <Button href="/g/kon-games?crear=1"><Plus class="w-4 h-4" /> {tr("gamesView.newGame")}</Button>
  {/snippet}

  <div class="space-y-6">
    <!-- Stats Row -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {#if statsLoading}
        {#each [1, 2, 3, 4] as _}
          <div class="card p-4 animate-pulse">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-kitsuden-muted/20"></div>
              <div class="space-y-2">
                <div class="h-3 w-16 bg-kitsuden-muted/20 rounded-sm"></div>
                <div class="h-5 w-10 bg-kitsuden-muted/20 rounded-sm"></div>
              </div>
            </div>
          </div>
        {/each}
      {:else}
        <div class="card p-4 flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center">
            <Gamepad2 class="w-4 h-4 text-kitsuden-accent" />
          </div>
          <div>
            <p class="text-xs text-kitsuden-subtle">{tr("gamesView.totalGames")}</p>
            <p class="text-xl font-semibold text-kitsuden-text">
              {totalGames.toLocaleString(localeFormat())}
            </p>
          </div>
        </div>
        <div class="card p-4 flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-kitsuden-green/10 flex items-center justify-center">
            <CheckCircle class="w-4 h-4 text-kitsuden-green" />
          </div>
          <div>
            <p class="text-xs text-kitsuden-subtle">{tr("common.published")}</p>
            <p class="text-xl font-semibold text-kitsuden-text">
              {publishedGames.toLocaleString(localeFormat())}
            </p>
          </div>
        </div>
        <div class="card p-4 flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-kitsuden-amber/10 flex items-center justify-center">
            <FileEdit class="w-4 h-4 text-kitsuden-amber" />
          </div>
          <div>
            <p class="text-xs text-kitsuden-subtle">{tr("gamesView.drafts")}</p>
            <p class="text-xl font-semibold text-kitsuden-text">
              {draftGames.toLocaleString(localeFormat())}
            </p>
          </div>
        </div>
        <div class="card p-4 flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-kitsuden-purple/10 flex items-center justify-center">
            <Layers class="w-4 h-4 text-kitsuden-purple" />
          </div>
          <div>
            <p class="text-xs text-kitsuden-subtle">{tr("gamesView.collections")}</p>
            <p class="text-xl font-semibold text-kitsuden-text">
              {totalCollections.toLocaleString(localeFormat())}
            </p>
          </div>
        </div>
      {/if}
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-1 border-b border-kitsuden-border pb-0">
      {#each [{ id: "games" as const, label: tr("gamesView.games") }, { id: "collections" as const, label: tr("gamesView.collections2") }, { id: "platforms" as const, label: tr("gamesView.platforms") }, { id: "tags" as const, label: tr("gamesView.tags") }] as t}
        <button
          class="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 {activeTab ===
          t.id
            ? 'text-kitsuden-accent border-kitsuden-accent bg-kitsuden-accent/5'
            : 'text-kitsuden-text-dim border-transparent hover:text-kitsuden-text hover:bg-kitsuden-card'}"
          onclick={() => (activeTab = t.id)}>{t.label}</button
        >
      {/each}
    </div>

    {#if activeTab === "games"}
      <div class="space-y-3 animate-fade-in">
        <div class="flex flex-wrap items-center gap-3">
          <div class="relative flex-1 min-w-48">
            <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-kitsuden-subtle" />
            <input
              type="text"
              placeholder={tr("gamesView.searchByTitleOrDeveloper")}
              class="w-full bg-kitsuden-card border border-kitsuden-input rounded-lg pl-9 pr-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
              bind:value={gamesSearch}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  gamesPage = 1;
                  loadGames();
                }
              }}
            />
          </div>
          <select
            class="bg-kitsuden-card border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
            bind:value={gamesStatus}
            onchange={() => {
              gamesPage = 1;
              loadGames();
            }}
          >
            <option value="">{tr("gamesView.allStatuses")}</option><option value="published"
              >{tr("common.published")}</option
            ><option value="draft">{tr("gamesView.draft")}</option><option value="archived"
              >{tr("common.archived")}</option
            >
          </select>
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              gamesPage = 1;
              loadGames();
            }}>{tr("common.filter")}</Button
          >
          {#if selectedGameIds.size > 0}
            <div class="flex items-center gap-2 ml-auto">
              <span class="text-xs text-kitsuden-subtle"
                >{selectedGameIds.size} {tr("common.selected")}</span
              >
              <Button
                variant="ghost"
                size="sm"
                class="text-kitsuden-amber"
                onclick={bulkToggleFeatured}
                ><Star class="w-3.5 h-3.5" /> {tr("gamesView.feature")}</Button
              >
              <Button variant="danger-ghost" size="sm" onclick={bulkDeleteGames}
                ><Trash2 class="w-3.5 h-3.5" /> {tr("common.delete")}</Button
              >
            </div>
          {/if}
        </div>

        <div class="card overflow-x-auto">
          <Table class="w-full text-sm">
            <TableHeader>
              <TableRow
                class="border-b border-kitsuden-border text-left text-xs text-kitsuden-subtle uppercase tracking-wider"
              >
                <TableHead class="px-4 py-3 w-10"
                  ><input
                    type="checkbox"
                    class="rounded-sm border-kitsuden-input bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent/30"
                    checked={selectedGameIds.size === games.length && games.length > 0}
                    onchange={toggleAll}
                  /></TableHead
                >
                <TableHead class="px-4 py-3 w-12">{tr("gamesView.cover")}</TableHead>
                <TableHead
                  class="px-4 py-3 cursor-pointer select-none"
                  onclick={() => toggleSort("title")}
                >
                  <span class="flex items-center gap-1"
                    >{tr("common.title")}
                    {#if gamesSort.field === "title"}{#if gamesSort.dir === "asc"}<ArrowUp
                          class="w-3 h-3"
                        />{:else}<ArrowDown class="w-3 h-3" />{/if}{:else}<ArrowUpDown
                        class="w-3 h-3 opacity-50"
                      />{/if}</span
                  >
                </TableHead>
                <TableHead class="px-4 py-3">{tr("common.status")}</TableHead>
                <TableHead class="px-4 py-3">{tr("gamesView.developer")}</TableHead>
                <TableHead
                  class="px-4 py-3 cursor-pointer select-none"
                  onclick={() => toggleSort("releaseDate")}
                >
                  <span class="flex items-center gap-1"
                    >{tr("gamesView.released")}
                    {#if gamesSort.field === "releaseDate"}{#if gamesSort.dir === "asc"}<ArrowUp
                          class="w-3 h-3"
                        />{:else}<ArrowDown class="w-3 h-3" />{/if}{:else}<ArrowUpDown
                        class="w-3 h-3 opacity-50"
                      />{/if}</span
                  >
                </TableHead>
                <TableHead
                  class="px-4 py-3 cursor-pointer select-none"
                  onclick={() => toggleSort("metacriticScore")}
                >
                  <span class="flex items-center gap-1"
                    >{tr("gamesView.metacritic")}
                    {#if gamesSort.field === "metacriticScore"}{#if gamesSort.dir === "asc"}<ArrowUp
                          class="w-3 h-3"
                        />{:else}<ArrowDown class="w-3 h-3" />{/if}{:else}<ArrowUpDown
                        class="w-3 h-3 opacity-50"
                      />{/if}</span
                  >
                </TableHead>
                <TableHead class="px-4 py-3 text-center">{tr("gamesView.featured")}</TableHead>
                <TableHead class="px-4 py-3 text-right">{tr("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#if gamesLoading}
                <TableRow
                  ><TableCell colspan={9} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><Loader2 class="w-6 h-6 animate-spin mx-auto" /></TableCell
                  ></TableRow
                >
              {:else if sortedGames().length === 0}
                <TableRow
                  ><TableCell colspan={9} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><PackageOpen class="w-8 h-8 mx-auto mb-2 opacity-50" />{tr(
                      "gamesView.noGamesFound"
                    )}</TableCell
                  ></TableRow
                >
              {:else}
                {#each sortedGames() as game (game.id)}
                  <TableRow
                    class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                  >
                    <TableCell class="px-4 py-2.5"
                      ><input
                        type="checkbox"
                        class="rounded-sm border-kitsuden-input bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent/30"
                        checked={selectedGameIds.has(game.id)}
                        onchange={() => toggleSelection(game.id)}
                      /></TableCell
                    >
                    <TableCell class="px-4 py-2.5">
                      <div
                        class="w-8 h-10 rounded-sm bg-kitsuden-muted/20 overflow-hidden border border-kitsuden-border"
                      >
                        {#if game.coverArtId}<img
                            src={`/api/media/preset/${game.coverArtId}/thumbnail`}
                            alt={game.title}
                            class="w-full h-full object-cover"
                            loading="lazy"
                          />{:else}<div
                            class="w-full h-full flex items-center justify-center text-xs"
                          >
                            🎮
                          </div>{/if}
                      </div>
                    </TableCell>
                    <!--
                    ── THESE TWO LINKS POINTED TO `/games/<id>`, WHICH DOES NOT EXIST ──

                    There is no `/games` route in the panel. And it did not give a visible
                    404 because nginx serves the panel for ANY route
                    —verified: `:3001/games/algo` responds 200—, so the
                    admin opened on a route its router does not know.

                    It is the same dead link that left `/games/new` as a 404 at
                    the very start of all this: that one was fixed and these were left,
                    one per row.

                    There is no game editor in the panel — games are edited
                    from the kon's grid with the generic modal—, so it
                    points to the kon's screen, which does exist. When there is an
                    editor of its own, these are the links to change.
                  -->
                    <TableCell class="px-4 py-2.5 font-medium text-kitsuden-text"
                      ><a href={"/g/kon-games"} class="hover:text-kitsuden-accent transition-colors"
                        >{game.title}</a
                      >
                      <div class="text-xs text-kitsuden-subtle">/{game.slug}</div></TableCell
                    >
                    <TableCell class="px-4 py-2.5"
                      ><span
                        class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border {statusClasses(
                          game.status
                        )}">{game.status}</span
                      ></TableCell
                    >
                    <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                      >{game.developer || "-"}</TableCell
                    >
                    <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                      >{formatDate(game.releaseDate)}</TableCell
                    >
                    <TableCell class="px-4 py-2.5"
                      ><span
                        class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold {metacriticClass(
                          game.metacriticScore
                        )}">{game.metacriticScore ?? "-"}</span
                      ></TableCell
                    >
                    <TableCell class="px-4 py-2.5 text-center"
                      ><input
                        type="checkbox"
                        class="rounded-sm border-kitsuden-input bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent/30"
                        checked={!!game.isFeaturedOnHome}
                        onchange={() => toggleFeatured(game)}
                      /></TableCell
                    >
                    <TableCell class="px-4 py-2.5 text-right"
                      ><div class="flex items-center justify-end gap-1">
                        <Button
                          href={"/g/kon-games"}
                          variant="ghost"
                          size="icon"
                          title={tr("common.edit")}><Pencil class="w-3.5 h-3.5" /></Button
                        ><Button
                          variant="danger-ghost"
                          size="icon"
                          title={tr("common.delete")}
                          onclick={() => deleteGame(game.id)}><Trash2 class="w-3.5 h-3.5" /></Button
                        >
                      </div></TableCell
                    >
                  </TableRow>
                {/each}
              {/if}
            </TableBody>
          </Table>
        </div>

        <div class="flex items-center justify-between">
          <p class="text-xs text-kitsuden-subtle">
            {tr("gamesView.pageOfTotal", { gamesPage, gamesTotalPages, gamesTotal })}
          </p>
          <div class="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={gamesPage <= 1}
              onclick={() => {
                gamesPage -= 1;
                loadGames();
              }}><ChevronLeft class="w-4 h-4" /></Button
            >
            <Button
              variant="secondary"
              size="sm"
              disabled={gamesPage >= gamesTotalPages}
              onclick={() => {
                gamesPage += 1;
                loadGames();
              }}><ChevronRight class="w-4 h-4" /></Button
            >
          </div>
        </div>
      </div>
    {:else if activeTab === "collections"}
      <div class="space-y-4 animate-fade-in">
        <div class="card p-4">
          <h3 class="text-sm font-semibold text-kitsuden-text mb-3 flex items-center gap-2">
            <Layers class="w-4 h-4 text-kitsuden-accent" />
            {tr("gamesView.newCollection")}
          </h3>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex-1 min-w-48">
              <label for="coll-name" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.name")}</label
              ><input
                id="coll-name"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGIndieGems")}
                value={newCollectionName}
                oninput={(e) => onCollName(e.currentTarget.value)}
              />
            </div>
            <div class="flex-1 min-w-48">
              <label for="coll-slug" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.slug")}</label
              ><input
                id="coll-slug"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.exampleTagSlug")}
                bind:value={newCollectionSlug}
              />
            </div>
            <Button size="sm" onclick={createCollection}
              ><Plus class="w-4 h-4" /> {tr("common.create")}</Button
            >
          </div>
        </div>

        <div class="card overflow-x-auto">
          <Table class="w-full text-sm">
            <TableHeader
              ><TableRow
                class="border-b border-kitsuden-border text-left text-xs text-kitsuden-subtle uppercase tracking-wider"
                ><TableHead class="px-4 py-3">{tr("common.name")}</TableHead><TableHead
                  class="px-4 py-3">{tr("common.slug")}</TableHead
                ><TableHead class="px-4 py-3">{tr("gamesView.order")}</TableHead><TableHead
                  class="px-4 py-3">{tr("common.games")}</TableHead
                ><TableHead class="px-4 py-3 text-right">{tr("common.actions")}</TableHead
                ></TableRow
              ></TableHeader
            >
            <TableBody>
              {#if collectionsLoading}<TableRow
                  ><TableCell colspan={5} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><Loader2 class="w-6 h-6 animate-spin mx-auto" /></TableCell
                  ></TableRow
                >
              {:else if collections.length === 0}<TableRow
                  ><TableCell colspan={5} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><PackageOpen class="w-8 h-8 mx-auto mb-2 opacity-50" />{tr(
                      "gamesView.noCollectionsYet"
                    )}</TableCell
                  ></TableRow
                >
              {:else}
                {#each collections as c (c.id)}
                  <TableRow
                    class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                  >
                    {#if editingCollectionId === c.id}
                      <TableCell class="px-4 py-2.5"
                        ><input
                          class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-sm px-2 py-1 text-sm"
                          bind:value={editCollectionName}
                        /></TableCell
                      >
                      <TableCell class="px-4 py-2.5"
                        ><input
                          class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-sm px-2 py-1 text-sm"
                          bind:value={editCollectionSlug}
                        /></TableCell
                      >
                      <TableCell class="px-4 py-2.5"
                        ><input
                          type="number"
                          class="w-20 bg-kitsuden-bg border border-kitsuden-input rounded-sm px-2 py-1 text-sm"
                          bind:value={editCollectionOrder}
                        /></TableCell
                      >
                      <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                        >{c.games?.length ?? 0}</TableCell
                      >
                      <TableCell class="px-4 py-2.5 text-right"
                        ><div class="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            class="text-kitsuden-green"
                            onclick={() => updateCollection(c)}><Save class="w-3.5 h-3.5" /></Button
                          ><Button
                            variant="ghost"
                            size="icon"
                            onclick={() => (editingCollectionId = null)}
                            ><X class="w-3.5 h-3.5" /></Button
                          >
                        </div></TableCell
                      >
                    {:else}
                      <TableCell class="px-4 py-2.5 font-medium text-kitsuden-text"
                        >{c.title}</TableCell
                      >
                      <TableCell class="px-4 py-2.5 text-kitsuden-text-dim">/{c.slug}</TableCell>
                      <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                        >{c.displayOrder ?? 0}</TableCell
                      >
                      <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                        >{c.games?.length ?? 0}</TableCell
                      >
                      <TableCell class="px-4 py-2.5 text-right"
                        ><div class="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" onclick={() => startEditColl(c)}
                            ><Pencil class="w-3.5 h-3.5" /></Button
                          ><Button
                            variant="danger-ghost"
                            size="icon"
                            onclick={() => deleteCollection(c.id)}
                            ><Trash2 class="w-3.5 h-3.5" /></Button
                          >
                        </div></TableCell
                      >
                    {/if}
                  </TableRow>
                {/each}
              {/if}
            </TableBody>
          </Table>
        </div>
      </div>
    {:else if activeTab === "platforms"}
      <div class="space-y-4 animate-fade-in">
        <div class="card p-4">
          <h3 class="text-sm font-semibold text-kitsuden-text mb-3 flex items-center gap-2">
            <Monitor class="w-4 h-4 text-kitsuden-accent" />
            {tr("gamesView.newPlatform")}
          </h3>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex-1 min-w-40">
              <label for="plat-name" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.name")}</label
              ><input
                id="plat-name"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGPlaystation5")}
                value={newPlatformName}
                oninput={(e) => onPlatName(e.currentTarget.value)}
              />
            </div>
            <div class="flex-1 min-w-40">
              <label for="plat-slug" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.slug")}</label
              ><input
                id="plat-slug"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGPs5")}
                bind:value={newPlatformSlug}
              />
            </div>
            <div class="flex-1 min-w-40">
              <label for="plat-mfr" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("gamesView.manufacturer")}</label
              ><input
                id="plat-mfr"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGSony")}
                bind:value={newPlatformManufacturer}
              />
            </div>
            <div class="w-24">
              <label for="plat-short" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("gamesView.short")}</label
              ><input
                id="plat-short"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder="PS5"
                bind:value={newPlatformShort}
              />
            </div>
            <Button size="sm" onclick={createPlatform}
              ><Plus class="w-4 h-4" /> {tr("gamesView.add")}</Button
            >
          </div>
        </div>

        <div class="card overflow-x-auto">
          <Table class="w-full text-sm">
            <TableHeader
              ><TableRow
                class="border-b border-kitsuden-border text-left text-xs text-kitsuden-subtle uppercase tracking-wider"
                ><TableHead class="px-4 py-3">{tr("common.name")}</TableHead><TableHead
                  class="px-4 py-3">{tr("common.slug")}</TableHead
                ><TableHead class="px-4 py-3">{tr("gamesView.manufacturer")}</TableHead><TableHead
                  class="px-4 py-3">{tr("gamesView.short")}</TableHead
                ></TableRow
              ></TableHeader
            >
            <TableBody>
              {#if platformsLoading}<TableRow
                  ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><Loader2 class="w-6 h-6 animate-spin mx-auto" /></TableCell
                  ></TableRow
                >
              {:else if platforms.length === 0}<TableRow
                  ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><PackageOpen class="w-8 h-8 mx-auto mb-2 opacity-50" />{tr(
                      "gamesView.noPlatformsYet"
                    )}</TableCell
                  ></TableRow
                >
              {:else}
                {#each platforms as p (p.id)}
                  <TableRow
                    class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                    ><TableCell class="px-4 py-2.5 font-medium text-kitsuden-text"
                      >{p.name}</TableCell
                    ><TableCell class="px-4 py-2.5 text-kitsuden-text-dim">/{p.slug}</TableCell
                    ><TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                      >{p.manufacturer || "-"}</TableCell
                    ><TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                      >{p.shortName || "-"}</TableCell
                    ></TableRow
                  >
                {/each}
              {/if}
            </TableBody>
          </Table>
        </div>
      </div>
    {:else if activeTab === "tags"}
      <div class="space-y-4 animate-fade-in">
        <div class="card p-4">
          <h3 class="text-sm font-semibold text-kitsuden-text mb-3 flex items-center gap-2">
            <Tag class="w-4 h-4 text-kitsuden-accent" />
            {tr("gamesView.newTag")}
          </h3>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex-1 min-w-40">
              <label for="tag-name" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.name")}</label
              ><input
                id="tag-name"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGRpg")}
                value={newTagName}
                oninput={(e) => onTagName(e.currentTarget.value)}
              />
            </div>
            <div class="flex-1 min-w-40">
              <label for="tag-slug" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.slug")}</label
              ><input
                id="tag-slug"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGRpg2")}
                bind:value={newTagSlug}
              />
            </div>
            <div class="w-28">
              <label for="tag-color" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("gamesView.color")}</label
              ><input
                id="tag-color"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder="#ff00ff"
                bind:value={newTagColor}
              />
            </div>
            <div class="flex-1 min-w-40">
              <label for="tag-cat" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.category")}</label
              ><input
                id="tag-cat"
                type="text"
                class="w-full bg-kitsuden-bg border border-kitsuden-input rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50"
                placeholder={tr("gamesView.eGGenre")}
                bind:value={newTagCategory}
              />
            </div>
            <Button size="sm" onclick={createTag}
              ><Plus class="w-4 h-4" /> {tr("gamesView.add")}</Button
            >
          </div>
        </div>

        <div class="card overflow-x-auto">
          <Table class="w-full text-sm">
            <TableHeader
              ><TableRow
                class="border-b border-kitsuden-border text-left text-xs text-kitsuden-subtle uppercase tracking-wider"
                ><TableHead class="px-4 py-3">{tr("common.name")}</TableHead><TableHead
                  class="px-4 py-3">{tr("common.slug")}</TableHead
                ><TableHead class="px-4 py-3">{tr("gamesView.color")}</TableHead><TableHead
                  class="px-4 py-3">{tr("common.category")}</TableHead
                ></TableRow
              ></TableHeader
            >
            <TableBody>
              {#if tagsLoading}<TableRow
                  ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><Loader2 class="w-6 h-6 animate-spin mx-auto" /></TableCell
                  ></TableRow
                >
              {:else if tags.length === 0}<TableRow
                  ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-subtle"
                    ><PackageOpen class="w-8 h-8 mx-auto mb-2 opacity-50" />{tr(
                      "gamesView.noTagsYet"
                    )}</TableCell
                  ></TableRow
                >
              {:else}
                {#each tags as t (t.id)}
                  <TableRow
                    class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                  >
                    <TableCell class="px-4 py-2.5 font-medium text-kitsuden-text"
                      >{t.name}</TableCell
                    >
                    <TableCell class="px-4 py-2.5 text-kitsuden-text-dim">/{t.slug}</TableCell>
                    <TableCell class="px-4 py-2.5"
                      >{#if t.color}<span class="inline-flex items-center gap-1.5"
                          ><span
                            class="w-3 h-3 rounded-full border border-kitsuden-border"
                            style={`background-color:${t.color}`}
                          ></span><span class="text-kitsuden-text-dim">{t.color}</span></span
                        >{:else}<span class="text-kitsuden-text-dim">-</span>{/if}</TableCell
                    >
                    <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                      >{t.category || "-"}</TableCell
                    >
                  </TableRow>
                {/each}
              {/if}
            </TableBody>
          </Table>
        </div>
      </div>
    {/if}
  </div>
</ViewPage>
