<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    Layers,
    Plus,
    ChevronLeft,
    ChevronRight,
    Pencil,
    Trash2,
    Star,
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
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    EmptyState,
    Field,
    Input,
    NumberInput,
    SearchInput,
    Select,
    Skeleton,
    Spinner,
    Stat,
    Tabs,
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

  function statusVariant(status: string): "success" | "warning" | "accent-2" | "default" {
    return status === "published"
      ? "success"
      : status === "draft"
        ? "warning"
        : status === "archived"
          ? "accent-2"
          : "default";
  }
  function metacriticVariant(s?: number): "default" | "success" | "warning" | "accent-2" {
    return s == null ? "default" : s >= 75 ? "success" : s >= 50 ? "warning" : "accent-2";
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
          <Skeleton height="4rem" />
        {/each}
      {:else}
        <Stat
          label={tr("gamesView.totalGames")}
          value={totalGames.toLocaleString(localeFormat())}
        />
        <Stat
          label={tr("common.published")}
          value={publishedGames.toLocaleString(localeFormat())}
          variant="success"
        />
        <Stat
          label={tr("gamesView.drafts")}
          value={draftGames.toLocaleString(localeFormat())}
          variant="warning"
        />
        <Stat
          label={tr("gamesView.collections")}
          value={totalCollections.toLocaleString(localeFormat())}
        />
      {/if}
    </div>

    <!-- Tabs -->
    <Tabs
      items={[
        { id: "games", label: tr("gamesView.games") },
        { id: "collections", label: tr("gamesView.collections2") },
        { id: "platforms", label: tr("gamesView.platforms") },
        { id: "tags", label: tr("gamesView.tags") },
      ]}
      value={activeTab}
      onchange={(id) => (activeTab = id as Tab)}
      panels={false}
      ariaLabel={tr("gamesView.sections")}
    />

    {#if activeTab === "games"}
      <div class="space-y-3 animate-fade-in">
        <div class="flex flex-wrap items-center gap-3">
          <form
            class="flex flex-1 flex-wrap items-center gap-3 min-w-0"
            onsubmit={(e) => {
              e.preventDefault();
              gamesPage = 1;
              loadGames();
            }}
          >
            <SearchInput
              class="flex-1 min-w-48"
              placeholder={tr("gamesView.searchByTitleOrDeveloper")}
              bind:value={gamesSearch}
            />
            <Select
              width="auto"
              aria-label={tr("common.status")}
              bind:value={gamesStatus}
              onchange={() => {
                gamesPage = 1;
                loadGames();
              }}
              options={[
                { value: "", label: tr("gamesView.allStatuses") },
                { value: "published", label: tr("common.published") },
                { value: "draft", label: tr("gamesView.draft") },
                { value: "archived", label: tr("common.archived") },
              ]}
            />
            <Button variant="secondary" size="sm" type="submit">{tr("common.filter")}</Button>
          </form>
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

        <Table class="w-full text-sm">
          <TableHeader>
            <TableRow
              class="border-b border-kitsuden-border text-left text-xs text-kitsuden-subtle uppercase tracking-wider"
            >
              <TableHead class="px-4 py-3 w-10"
                ><Checkbox
                  ariaLabel={tr("gamesView.selectAll")}
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
                  ><span class="flex justify-center"><Spinner /></span></TableCell
                ></TableRow
              >
            {:else if sortedGames().length === 0}
              <TableRow
                ><TableCell colspan={9} class="px-4 py-12 text-center text-kitsuden-subtle"
                  ><EmptyState
                    size="sm"
                    level={null}
                    title={tr("gamesView.noGamesFound")}
                  /></TableCell
                ></TableRow
              >
            {:else}
              {#each sortedGames() as game (game.id)}
                <TableRow
                  class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                >
                  <TableCell class="px-4 py-2.5"
                    ><Checkbox
                      ariaLabel={tr("gamesView.selectGame", { name: game.title })}
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
                    ><Badge variant={statusVariant(game.status)}>{game.status}</Badge></TableCell
                  >
                  <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                    >{game.developer || "-"}</TableCell
                  >
                  <TableCell class="px-4 py-2.5 text-kitsuden-text-dim"
                    >{formatDate(game.releaseDate)}</TableCell
                  >
                  <TableCell class="px-4 py-2.5"
                    ><Badge variant={metacriticVariant(game.metacriticScore)}
                      >{game.metacriticScore ?? "-"}</Badge
                    ></TableCell
                  >
                  <TableCell class="px-4 py-2.5 text-center"
                    ><Checkbox
                      ariaLabel={tr("gamesView.featureGame", { name: game.title })}
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
                        title={tr("common.edit")}
                        ariaLabel={tr("common.edit")}><Pencil class="w-3.5 h-3.5" /></Button
                      ><Button
                        variant="danger-ghost"
                        size="icon"
                        title={tr("common.delete")}
                        ariaLabel={tr("common.delete")}
                        onclick={() => deleteGame(game.id)}><Trash2 class="w-3.5 h-3.5" /></Button
                      >
                    </div></TableCell
                  >
                </TableRow>
              {/each}
            {/if}
          </TableBody>
        </Table>

        <div class="flex items-center justify-between">
          <p class="text-xs text-kitsuden-subtle">
            {tr("gamesView.pageOfTotal", { gamesPage, gamesTotalPages, gamesTotal })}
          </p>
          <div class="flex items-center gap-2">
            <Button
              variant="secondary"
              size="icon"
              ariaLabel={tr("gamesView.previousPage")}
              disabled={gamesPage <= 1}
              onclick={() => {
                gamesPage -= 1;
                loadGames();
              }}><ChevronLeft class="w-4 h-4" /></Button
            >
            <Button
              variant="secondary"
              size="icon"
              ariaLabel={tr("gamesView.nextPage")}
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
        <Card
          ><CardHeader
            ><CardTitle class="flex items-center gap-2">
              <Layers class="w-4 h-4 text-kitsuden-accent" />
              {tr("gamesView.newCollection")}
            </CardTitle></CardHeader
          ><CardContent>
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex-1 min-w-48">
                <Field label={tr("common.name")}
                  ><Input
                    id="coll-name"
                    placeholder={tr("gamesView.eGIndieGems")}
                    value={newCollectionName}
                    oninput={(e: Event) => onCollName((e.currentTarget as HTMLInputElement).value)}
                  /></Field
                >
              </div>
              <div class="flex-1 min-w-48">
                <Field label={tr("common.slug")}
                  ><Input
                    id="coll-slug"
                    placeholder={tr("gamesView.exampleTagSlug")}
                    bind:value={newCollectionSlug}
                  /></Field
                >
              </div>
              <Button size="sm" onclick={createCollection}
                ><Plus class="w-4 h-4" /> {tr("common.create")}</Button
              >
            </div></CardContent
          ></Card
        >

        <Table class="w-full text-sm">
          <TableHeader
            ><TableRow
              class="border-b border-kitsuden-border text-left text-xs text-kitsuden-subtle uppercase tracking-wider"
              ><TableHead class="px-4 py-3">{tr("common.name")}</TableHead><TableHead
                class="px-4 py-3">{tr("common.slug")}</TableHead
              ><TableHead class="px-4 py-3">{tr("gamesView.order")}</TableHead><TableHead
                class="px-4 py-3">{tr("common.games")}</TableHead
              ><TableHead class="px-4 py-3 text-right">{tr("common.actions")}</TableHead></TableRow
            ></TableHeader
          >
          <TableBody>
            {#if collectionsLoading}<TableRow
                ><TableCell colspan={5} class="px-4 py-12 text-center text-kitsuden-subtle"
                  ><span class="flex justify-center"><Spinner /></span></TableCell
                ></TableRow
              >
            {:else if collections.length === 0}<TableRow
                ><TableCell colspan={5} class="px-4 py-12 text-center text-kitsuden-subtle"
                  ><EmptyState
                    size="sm"
                    level={null}
                    title={tr("gamesView.noCollectionsYet")}
                  /></TableCell
                ></TableRow
              >
            {:else}
              {#each collections as c (c.id)}
                <TableRow
                  class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                >
                  {#if editingCollectionId === c.id}
                    <TableCell class="px-4 py-2.5"
                      ><Input
                        aria-label={tr("common.name")}
                        bind:value={editCollectionName}
                      /></TableCell
                    >
                    <TableCell class="px-4 py-2.5"
                      ><Input
                        aria-label={tr("common.slug")}
                        bind:value={editCollectionSlug}
                      /></TableCell
                    >
                    <TableCell class="px-4 py-2.5"
                      ><NumberInput
                        width="auto"
                        ariaLabel={tr("gamesView.order")}
                        value={editCollectionOrder}
                        onchange={(n) => (editCollectionOrder = n ?? 0)}
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
                          ariaLabel={tr("gamesView.saveCollection")}
                          onclick={() => updateCollection(c)}><Save class="w-3.5 h-3.5" /></Button
                        ><Button
                          variant="ghost"
                          size="icon"
                          ariaLabel={tr("common.cancel")}
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
                        <Button
                          variant="ghost"
                          size="icon"
                          ariaLabel={tr("common.edit")}
                          onclick={() => startEditColl(c)}><Pencil class="w-3.5 h-3.5" /></Button
                        ><Button
                          variant="danger-ghost"
                          size="icon"
                          ariaLabel={tr("common.delete")}
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
    {:else if activeTab === "platforms"}
      <div class="space-y-4 animate-fade-in">
        <Card
          ><CardHeader
            ><CardTitle class="flex items-center gap-2">
              <Monitor class="w-4 h-4 text-kitsuden-accent" />
              {tr("gamesView.newPlatform")}
            </CardTitle></CardHeader
          ><CardContent>
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex-1 min-w-40">
                <Field label={tr("common.name")}
                  ><Input
                    id="plat-name"
                    placeholder={tr("gamesView.eGPlaystation5")}
                    value={newPlatformName}
                    oninput={(e: Event) => onPlatName((e.currentTarget as HTMLInputElement).value)}
                  /></Field
                >
              </div>
              <div class="flex-1 min-w-40">
                <Field label={tr("common.slug")}
                  ><Input
                    id="plat-slug"
                    placeholder={tr("gamesView.eGPs5")}
                    bind:value={newPlatformSlug}
                  /></Field
                >
              </div>
              <div class="flex-1 min-w-40">
                <Field label={tr("gamesView.manufacturer")}
                  ><Input
                    id="plat-mfr"
                    placeholder={tr("gamesView.eGSony")}
                    bind:value={newPlatformManufacturer}
                  /></Field
                >
              </div>
              <div class="w-24">
                <Field label={tr("gamesView.short")}
                  ><Input id="plat-short" placeholder="PS5" bind:value={newPlatformShort} /></Field
                >
              </div>
              <Button size="sm" onclick={createPlatform}
                ><Plus class="w-4 h-4" /> {tr("gamesView.add")}</Button
              >
            </div></CardContent
          ></Card
        >

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
                  ><span class="flex justify-center"><Spinner /></span></TableCell
                ></TableRow
              >
            {:else if platforms.length === 0}<TableRow
                ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-subtle"
                  ><EmptyState
                    size="sm"
                    level={null}
                    title={tr("gamesView.noPlatformsYet")}
                  /></TableCell
                ></TableRow
              >
            {:else}
              {#each platforms as p (p.id)}
                <TableRow
                  class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                  ><TableCell class="px-4 py-2.5 font-medium text-kitsuden-text">{p.name}</TableCell
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
    {:else if activeTab === "tags"}
      <div class="space-y-4 animate-fade-in">
        <Card
          ><CardHeader
            ><CardTitle class="flex items-center gap-2">
              <Tag class="w-4 h-4 text-kitsuden-accent" />
              {tr("gamesView.newTag")}
            </CardTitle></CardHeader
          ><CardContent>
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex-1 min-w-40">
                <Field label={tr("common.name")}
                  ><Input
                    id="tag-name"
                    placeholder={tr("gamesView.eGRpg")}
                    value={newTagName}
                    oninput={(e: Event) => onTagName((e.currentTarget as HTMLInputElement).value)}
                  /></Field
                >
              </div>
              <div class="flex-1 min-w-40">
                <Field label={tr("common.slug")}
                  ><Input
                    id="tag-slug"
                    placeholder={tr("gamesView.eGRpg2")}
                    bind:value={newTagSlug}
                  /></Field
                >
              </div>
              <div class="w-28">
                <Field label={tr("gamesView.color")}
                  ><Input id="tag-color" placeholder="#ff00ff" bind:value={newTagColor} /></Field
                >
              </div>
              <div class="flex-1 min-w-40">
                <Field label={tr("common.category")}
                  ><Input
                    id="tag-cat"
                    placeholder={tr("gamesView.eGGenre")}
                    bind:value={newTagCategory}
                  /></Field
                >
              </div>
              <Button size="sm" onclick={createTag}
                ><Plus class="w-4 h-4" /> {tr("gamesView.add")}</Button
              >
            </div></CardContent
          ></Card
        >

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
                  ><span class="flex justify-center"><Spinner /></span></TableCell
                ></TableRow
              >
            {:else if tags.length === 0}<TableRow
                ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-subtle"
                  ><EmptyState
                    size="sm"
                    level={null}
                    title={tr("gamesView.noTagsYet")}
                  /></TableCell
                ></TableRow
              >
            {:else}
              {#each tags as t (t.id)}
                <TableRow
                  class="border-b border-kitsuden-border/50 hover:bg-kitsuden-muted/10 transition-colors"
                >
                  <TableCell class="px-4 py-2.5 font-medium text-kitsuden-text">{t.name}</TableCell>
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
    {/if}
  </div>
</ViewPage>
