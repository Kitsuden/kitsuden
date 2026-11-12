<script lang="ts">
  import PageCrumbs from "$lib/components/admin/PageCrumbs.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  /**
   * BlogPostEditor.svelte — Complete Blog Post Editor with SEO
   *
   * Features:
   * ✓ Rich Text Editor (MDX)
   * ✓ SEO Panel (meta title, description, OG tags, robots)
   * ✓ Featured Image Selector
   * ✓ Tags Management
   * ✓ Scheduling (datepicker)
   * ✓ Author Selector
   * ✓ Google/Social Preview
   */
  import {
    ArrowLeft,
    Save,
    FileText,
    Trash2,
    Eye,
    EyeOff,
    Calendar,
    Clock,
    User,
    Tag,
    Image,
    Settings,
    Search,
    Share2,
    CheckCircle2,
    X,
    Plus,
    Database,
    LayoutGrid,
    FolderTree,
    Gamepad2,
    History,
    AlertTriangle,
    Users,
  } from "lucide-svelte";
  import { onMount, onDestroy, untrack } from "svelte";

  import MdxEditor from "$lib/components/editor/MdxEditor.svelte";
  import PageBuilder from "$lib/components/builder/PageBuilder.svelte";
  import type { PageBlock } from "$types/blocks";

  import { api } from "$lib/api";
  import { getUser, isAdmin } from "$lib/auth.svelte";
  import { moduleStore } from "$lib/states/modules.svelte";
  import { mediaUrl } from "$lib/states/media.svelte";
  import PromoteFromDataset from "$lib/components/blog/PromoteFromDataset.svelte";
  import SlashCommandEditor from "$lib/components/editor/SlashCommandEditor.svelte";
  import LivePreview from "$lib/components/LivePreview.svelte";
  import SplitPane from "$lib/components/SplitPane.svelte";
  import MediaPicker from "$lib/components/media/MediaPicker.svelte";
  import { uploadMedia } from "$lib/media/upload";
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    Label,
    Progress,
    Select,
    Spinner,
    Tabs,
    Toggle,
    ToggleGroup,
    type TabItem,
    Input,
    Dialog,
    Textarea,
  } from "$lib/tallao";
  import AutoSaveIndicator from "$lib/components/admin/AutoSaveIndicator.svelte";
  import { autosaveStore } from "$lib/states/autosave.svelte";
  import type { ApiError, BlogCategory } from "$lib/api";

  import { goto } from "$app/navigation";

  // ─── Props ──────────────────────────────────────────
  interface Props {
    postId?: string | null;
  }

  const { postId = null }: Props = $props();

  // ─── State ──────────────────────────────────────────
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let activeTab = $state<"content" | "blocks" | "seo" | "settings">("content");
  const EDITOR_TABS: TabItem[] = (["content", "blocks", "seo", "settings"] as const).map((id) => ({
    id,
    label: {
      content: tr("common.content"),
      blocks: tr("blogPostEditor.blocks"),
      seo: tr("blogPostEditor.seo"),
      settings: tr("common.settings"),
    }[id],
    controls: `post-panel-${id}`,
    tabId: `post-tab-${id}`,
  }));
  const TAB_ICONS = { content: FileText, blocks: LayoutGrid, seo: Search, settings: Settings };

  /**
   * How the content is written. ONE field, two ways of writing it.
   *
   * ── WHY THEY ARE NOT TWO EDITORS ─────────────────────────────────────────
   *
   * There were THREE editing components in the repo and two different screens:
   *
   *   · `SlashCommandEditor` — text area with a slash menu. Used by this
   *     editor, which was the only one that knew how to save.
   *   · `MdxEditor` — markdown with live preview. Lived in `EditorView`,
   *     a separate screen whose «Save Draft» button had NO `onclick`: you could
   *     write and nothing was saved.
   *   · `PageBuilder` — blocks. On yet another screen.
   *
   * The first two emit exactly the same thing —a markdown string— so
   * they were not two editors: they were two interfaces over the same field,
   * separated by accident. Here they coexist as modes, and switching from one to the other
   * loses nothing because the data is the same.
   *
   * Blocks ARE a different field (`blocks`, jsonb) and that is why they have their own
   * tab, not a mode.
   */
  let contentMode = $state<"markdown" | "fast">("markdown");
  let showMediaModal = $state(false);

  /**
   * What the media library was opened for.
   *
   * The same modal serves the COVER image and inserting one in the
   * TEXT. Without this distinction, choosing an image for the article body
   * would change the post's cover — and vice versa.
   */
  let imageTarget = $state<"portada" | "contenido">("portada");

  /**
   * Both editors expose `insertImage`. The reference is needed because
   * the cursor position lives inside each one: the container knows WHICH
   * image, the editor knows WHERE.
   */
  let editorMarkdown = $state<{ insertImage: (url: string, alt?: string) => void } | null>(null);
  let quickEditor = $state<{
    insertImage: (url: string, alt?: string) => void;
    rememberPosition: () => void;
  } | null>(null);

  /** Search text of the media picker. */
  let mediaSearch = $state("");
  let searchingMedia = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let uploadingImage = $state(false);
  let uploadError = $state<string | null>(null);
  let showTagModal = $state(false);
  let showDatasetModal = $state(false);
  let availableTags = $state<Array<{ id: string; name: string; slug: string }>>([]);
  let availableAuthors = $state<Array<{ id: string; name: string; email: string; image?: string }>>(
    []
  );
  let mediaList = $state<Array<{ id: string; url: string; filename: string; alt?: string }>>([]);
  let newTagName = $state("");
  let showPreview = $state(false);

  // Post data
  let title = $state("");
  let slug = $state("");
  let content = $state("");
  let excerpt = $state("");
  let status = $state<"draft" | "published" | "scheduled" | "archived">("draft");
  /** This article's comment thread. Open by default, as in WordPress. */
  let commentsEnabled = $state(true);

  /**
   * ── LANGUAGE AND TRANSLATION GROUP ────────────────────────────────────────
   *
   * One entry per language, tied together by `translationGroupId`: the YouTube
   * model. To translate an article ANOTHER article is created, given its
   * language, and the original's group is pasted here.
   *
   * The group is shown as text and not as a dropdown on purpose: the list
   * of translatable articles can run to thousands, and the real case is «I just
   * copied the original's link». The button next to it fills it in with the
   * group of the article being edited.
   */
  let locale = $state("es");
  let translationGroupId = $state("");
  const PANEL_LANGUAGES = [
    { code: "es", name: tr("blogPostEditor.spanish") },
    { code: "en", name: tr("blogPostEditor.english") },
    { code: "pt", name: tr("blogPostEditor.portuguese") },
  ];
  /**
   * Which template it is rendered with on the web.
   *
   * `tips` is the numbered list with a sticky side index: each H2 of the
   * content becomes a step in the index. For «12 tips to
   * get started» and other lists; for everything else, `article`.
   */
  let layout = $state<"article" | "tips">("article");
  let publishedAt = $state<string>("");
  let authorId = $state<string>("");
  let featuredImageId = $state<string>("");
  let featuredImageUrl = $state<string>("");
  let tags = $state<Array<{ id: string; name: string; slug: string }>>([]);
  /** The post's categories (ids). The full catalog is in `availableCategories`. */
  let categoryIds = $state<string[]>([]);

  /**
   * The games the entry is about.
   *
   * The API had accepted `gameIds` from the start and the bridge table existed,
   * but the panel did not show them: tying an entry to its game could only be done
   * with a manual call. The badge the front page puts on the card
   * comes from that relation, so without this there would be no way for it to appear.
   */
  let gameIds = $state<string[]>([]);
  /**
   * Whether `gameIds` holds what the post really has. Saving sent `gameIds: []` on every
   * edit, and for the API `[]` means "remove them all": with kon-games off (nothing to load,
   * nothing to tick) or a post whose answer did not bring the field, an edit of the title
   * wiped the post's games. It is sent only when it was loaded and kon-games is on.
   */
  let gameIdsLoaded = false;
  let gameKonOn = false;
  let availableGames = $state<Array<{ id: string; title: string }>>([]);
  let availableCategories = $state<BlogCategory[]>([]);
  let showCategoryModal = $state(false);
  let newCategory = $state({ name: "", parentId: "" });

  /**
   * Version mark with which the post was opened.
   *
   * It travels with every save as `expectedUpdatedAt` and is what lets the
   * API detect that someone else saved in the meantime. It is refreshed after
   * each of our own saves, because from then on the good version is ours.
   */
  let loadedVersion = $state<string | null>(null);

  /** Simultaneous-edit warning (409). Kept separate from `error` because it is not a failure. */
  let conflict = $state<{ message: string; when: string | null } | null>(null);

  /** Local draft found on open, awaiting a decision. */
  let pendingDraft = $state<{ when: number; data: Record<string, any> } | null>(null);
  /** The post's blocks. `blocks` column (jsonb); the API accepts them on create and on edit. */
  let blocks = $state<PageBlock[]>([]);
  let seoOverrides = $state({
    metaTitle: "",
    metaDescription: "",
    ogTitle: "",
    ogDescription: "",
    ogImageId: "",
    canonicalUrl: "",
    robotsIndex: true,
    robotsFollow: true,
    structuredData: {} as any,
    /**
     * The community groups this ENTRY announces («Join
     * the group» cards at the end of the article). They live here and not in their own column:
     * `seo_overrides` is the table's only free-form jsonb and the API stores its
     * keys as they are, so no migration is needed. Empty = the site's.
     */
    facebookGroupUrl: "",
    whatsappGroupUrl: "",
  });

  /**
   * Groups arrive as null from the API (they are stored that way when empty)
   * and the form works with text: without this, a post saved without a group
   * would break the editor when calling .trim() on null.
   */
  function withGroupsInText<T extends { facebookGroupUrl?: unknown; whatsappGroupUrl?: unknown }>(
    s: T
  ) {
    return {
      ...s,
      facebookGroupUrl: typeof s.facebookGroupUrl === "string" ? s.facebookGroupUrl : "",
      whatsappGroupUrl: typeof s.whatsappGroupUrl === "string" ? s.whatsappGroupUrl : "",
    };
  }

  /** The same rules the site applies: whatever does not pass is not shown */
  const validFacebookLink = (u: string) =>
    /^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[^\s"'<>]+$/i.test(u.trim());
  const validWhatsappLink = (u: string) =>
    /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,40}\/?$/.test(u.trim());

  // ─── Derived state ─────────────────────────────────
  const isScheduled = $derived(status === "scheduled");
  const isPublished = $derived(status === "published");
  const metaTitlePreview = $derived(seoOverrides.metaTitle || title);
  const metaDescPreview = $derived(seoOverrides.metaDescription || excerpt);
  const seoScore = $derived(calculateSeoScore());

  function calculateSeoScore(): number {
    let score = 0;
    let max = 0;

    // Title checks (20 points)
    max += 20;
    if (title.length >= 30 && title.length <= 60) score += 20;
    else if (title.length > 0) score += 10;

    // Slug (10 points)
    max += 10;
    if (slug.length > 0) score += 10;

    // Content (20 points)
    max += 20;
    if (content.length > 300) score += 20;
    else if (content.length > 0) score += 10;

    // Excerpt (10 points)
    max += 10;
    if (excerpt.length >= 120 && excerpt.length <= 160) score += 10;
    else if (excerpt.length > 0) score += 5;

    // SEO overrides (20 points)
    max += 20;
    if (seoOverrides.metaTitle) score += 10;
    if (seoOverrides.metaDescription) score += 10;

    // Featured image (10 points)
    max += 10;
    if (featuredImageId) score += 10;

    // Tags (10 points)
    max += 10;
    if (tags.length > 0) score += Math.min(tags.length * 2, 10);

    return Math.round((score / max) * 100);
  }

  // ─── Autoguardado local ─────────────────────────────
  //
  // ── WHAT IT SOLVES, AND WHAT IT DOES NOT ──────────────────────────────────
  //
  // Closing the tab mid-entry lost EVERYTHING that had been written. There was no copy in
  // any place: no local draft, no version history in the database.
  //
  // This is the first, not the second: it saves to the browser's `localStorage`
  // every few seconds and offers recovery on reopening. It is NOT a
  // version history of the post —that lives on the server and is something else— nor
  // is it useful for recovering from another computer.
  //
  // `autosaveStore` already existed in the repo, complete, used only by
  // `AutoFormModal`. This plugs it in; it reimplements nothing.

  /** Draft key. A new post and an existing one do not share a drawer. */
  const draftKey = `blog_${postId ?? "new"}`;

  /**
   * What is saved. Everything the editor can change and nothing more: if
   * something derived got in here (the `seoScore`, for example) every recalculation
   * would mark the draft as dirty without anyone having typed a letter.
   */
  function snapshot(): Record<string, any> {
    return {
      title,
      slug,
      content,
      blocks,
      excerpt,
      status,
      layout,
      publishedAt,
      authorId,
      featuredImageId,
      featuredImageUrl,
      tags,
      categoryIds,
      gameIds,
      seoOverrides,
    };
  }

  function applySnapshot(d: Record<string, any>) {
    title = d.title ?? "";
    slug = d.slug ?? "";
    content = d.content ?? "";
    blocks = Array.isArray(d.blocks) ? d.blocks : [];
    excerpt = d.excerpt ?? "";
    status = d.status ?? "draft";
    layout = d.layout === "tips" ? "tips" : "article";
    publishedAt = d.publishedAt ?? "";
    authorId = d.authorId ?? "";
    featuredImageId = d.featuredImageId ?? "";
    featuredImageUrl = d.featuredImageUrl ?? "";
    tags = Array.isArray(d.tags) ? d.tags : [];
    categoryIds = Array.isArray(d.categoryIds) ? d.categoryIds : [];
    gameIds = Array.isArray(d.gameIds) ? d.gameIds : [];
    if (d.seoOverrides) seoOverrides = withGroupsInText({ ...seoOverrides, ...d.seoOverrides });
  }

  /**
   * Every change feeds the store.
   *
   * `untrack` around `updateData` is NOT decoration: the store is reactive
   * (`status` is `$state`) and writing it inside an `$effect` that also read it
   * would create a feedback loop. It already happened once in this same
   * panel, with the explorer's view selector, and the symptom —the interface
   * fighting with whoever uses it— looks nothing like the cause.
   */
  $effect(() => {
    const dataValue = snapshot();
    if (!autosaveStore.currentKey) return;
    untrack(() => autosaveStore.updateData(dataValue));
  });

  /**
   * Restoring a version from the history has to MOVE the form.
   *
   * `AutoSaveIndicator` unfolds `VersionHistory`, and its «Restore» button calls
   * `restoreVersion`, which leaves the data in `autosaveStore.restoredData` and that is
   * it: the store does not know how to paint anything. Without this effect the button exists,
   * is pressed, gives no error — and NOTHING happens. It is the same pattern the block
   * editor had before being wired up: complete code and unplugged.
   *
   * `restoredData` is cleared afterwards so it is not applied again by itself.
   */
  $effect(() => {
    const recovered = autosaveStore.restoredData;
    if (!recovered) return;
    untrack(() => {
      applySnapshot(recovered);
      autosaveStore.restoredData = null;
    });
  });

  // The draft SURVIVES closing: the clock is stopped, it is not deleted. Deleting it
  // here would make leaving the screen destroy exactly what this protects.
  onDestroy(() => autosaveStore.stopAutosave());

  function recoverDraft() {
    if (!pendingDraft) return;
    applySnapshot(pendingDraft.data);
    pendingDraft = null;
  }

  function discardDraft() {
    autosaveStore.deleteAllVersions(draftKey);
    pendingDraft = null;
    autosaveStore.startAutosave(draftKey, snapshot());
  }

  // ─── Lifecycle ──────────────────────────────────────
  onMount(async () => {
    try {
      // No `loadMedia()`: the library is no longer preloaded when the editor opens.
      // `MediaPicker` loads it when it is actually opened, which is correct —
      // most of the time a post is written without touching any image, and
      // that request went unused.
      await Promise.all([loadTags(), loadCategories(), loadAuthors(), loadGames()]);

      if (postId) {
        await loadPost();
      }

      /**
       * Autosave starts AFTER loading, not before.
       *
       * If it started earlier, its first snapshot would be the empty form and
       * loading the post would count as «unsaved changes» right on opening.
       */
      const saved = autosaveStore.savedVersions(draftKey);
      const last = saved[0];

      /**
       * Recovery is only offered if the draft is NEWER than what is on
       * the server. Otherwise it would be offering to go back to an old version after
       * having saved properly — which is losing work, not recovering it.
       */
      const savedOnServer = loadedVersion ? new Date(loadedVersion).getTime() : 0;
      if (last && last.timestamp > savedOnServer) {
        pendingDraft = { when: last.timestamp, data: last.data };
      } else if (last) {
        autosaveStore.deleteAllVersions(draftKey);
      }

      autosaveStore.startAutosave(draftKey, snapshot());
    } catch (err: any) {
      error = err.message || tr("blogPostEditor.failedToInitializeEditor");
    } finally {
      loading = false;
    }
  });

  // ─── Data loading ───────────────────────────────────
  async function loadPost() {
    try {
      const post = await api.getPost(postId!);
      title = post.title || "";
      slug = post.slug || "";
      /**
       * `content` is `jsonb` in the database and the three editors speak in STRINGS.
       *
       * An old row could carry an object instead of text —jsonb admits
       * both— and then the editor would render `[object Object]` and
       * save it that way, destroying the post on first save. It is normalized
       * on load instead of trusting.
       */
      content =
        typeof post.content === "string"
          ? post.content
          : post.content
            ? JSON.stringify(post.content, null, 2)
            : "";
      blocks = Array.isArray((post as { blocks?: PageBlock[] }).blocks)
        ? ((post as { blocks?: PageBlock[] }).blocks as PageBlock[])
        : [];
      excerpt = post.excerpt || "";
      status = post.status || "draft";
      // `!== false` and not `=== true`: a post predating the column brings
      // `undefined`, and with `=== true` it would come out closed without anyone
      // having decided so.
      commentsEnabled = post.commentsEnabled !== false;
      locale = (post as any).locale || "es";
      translationGroupId = (post as any).translationGroupId || "";
      layout = post.layout === "tips" ? "tips" : "article";
      publishedAt = post.publishedAt ? new Date(post.publishedAt).toISOString().slice(0, 16) : "";
      authorId = post.authorId || "";
      featuredImageId = post.featuredImageId || "";
      featuredImageUrl = post.featuredImage?.url || "";
      /**
       * Tags arrive as IDS and here they are needed as objects.
       *
       * Before, this was `post.tags || []`, and the API has never returned `tags`:
       * `GET /api/blog/:id` delivered the raw row and tags live in
       * a relation table. Result: opening an existing post showed it
       * ALWAYS without tags. It looked like «this post has none», not like «I haven't
       * brought them to you».
       *
       * `availableTags` is already loaded in `onMount`, so the mapping is local.
       */
      const tagIds = (post as { tagIds?: string[] }).tagIds ?? [];
      tags = tagIds
        .map((id) => availableTags.find((t) => t.id === id))
        .filter((t): t is { id: string; name: string; slug: string } => !!t);

      gameIdsLoaded = Array.isArray((post as { gameIds?: string[] }).gameIds);
      gameIds = gameIdsLoaded ? ((post as { gameIds?: string[] }).gameIds as string[]) : [];
      keepPostAuthor(post as { authorId?: string | null; author?: PostAuthor | null });
      categoryIds = Array.isArray((post as { categoryIds?: string[] }).categoryIds)
        ? ((post as { categoryIds?: string[] }).categoryIds as string[])
        : [];

      // The version it is opened with. Without this there is no way to detect that
      // someone else saved underneath.
      loadedVersion = (post as { updatedAt?: string }).updatedAt ?? null;

      if (post.seoOverrides) {
        seoOverrides = withGroupsInText({
          ...seoOverrides,
          ...post.seoOverrides,
        });
      }
    } catch (err: any) {
      error = err.message || tr("blogPostEditor.failedToLoadPost");
    }
  }

  async function loadGames() {
    gameKonOn = await hasGameKon();
    if (!gameKonOn) return;
    try {
      const responseValue = await api.getGames({ limit: 100 });
      availableGames = (responseValue.docs ?? []).map((game) => ({
        id: game.id,
        title: game.title,
      }));
    } catch {
      // With no games kon installed there is nothing to choose, and that is not an
      // editor error: the rest of the form still works.
      availableGames = [];
    }
  }

  async function loadCategories() {
    try {
      const responseValue = await api.getBlogCategories();
      availableCategories = responseValue.docs || [];
    } catch (err) {
      // A catalog failure cannot prevent editing the post.
      console.error("Failed to load categories:", err);
    }
  }

  function toggleGame(id: string) {
    gameIds = gameIds.includes(id) ? gameIds.filter((x) => x !== id) : [...gameIds, id];
  }

  function toggleCategory(id: string) {
    categoryIds = categoryIds.includes(id)
      ? categoryIds.filter((x) => x !== id)
      : [...categoryIds, id];
  }

  /** Name indented according to depth, so the tree reads flat. */
  function depthOf(cat: BlogCategory): number {
    let n = 0;
    let actual: BlogCategory | undefined = cat;
    // The cap cuts off any ring that slipped in; the API prevents it on
    // write, but this is rendered with whatever arrives.
    while (actual?.parentId && n < 10) {
      actual = availableCategories.find((x) => x.id === actual!.parentId);
      n++;
    }
    return n;
  }

  async function createCategory() {
    if (!newCategory.name.trim()) return;
    try {
      const createdOne = await api.createBlogCategory({
        name: newCategory.name.trim(),
        slug: generateSlug(newCategory.name),
        parentId: newCategory.parentId || null,
      });
      availableCategories = [...availableCategories, createdOne];
      categoryIds = [...categoryIds, createdOne.id];
      newCategory = { name: "", parentId: "" };
    } catch (err: any) {
      error = err.message || tr("blogPostEditor.couldNotCreateThe");
    }
  }

  async function loadTags() {
    if (!(await hasGameKon())) return;
    try {
      const response = await api.getTags();
      availableTags = response.docs || [];
    } catch (err) {
      console.error("Failed to load tags:", err);
    }
  }

  async function loadAuthors() {
    // There is no account listing for the editor: whoever writes is offered. Before it was
    // an invented author (id "1", user@example.com) that ended up in `authorId`.
    const yo = getUser() as { id?: string; name?: string | null; email?: string } | null;
    availableAuthors = yo?.id
      ? [
          {
            id: yo.id,
            name: yo.name || yo.email || tr("blogPostEditor.currentUser"),
            email: yo.email ?? "",
          },
        ]
      : [];
  }

  type PostAuthor = { id?: string; displayName?: string | null; name?: string | null };

  /**
   * The post's own author stays in the list. There is no account listing, so the options
   * were only the session user: a post written by someone else showed the selector blank,
   * as if it had no author. `GET /api/blog/:id` sends `author: { id, displayName, image }`.
   */
  function keepPostAuthor(post: { authorId?: string | null; author?: PostAuthor | null }) {
    const id = post.authorId || post.author?.id;
    if (!id || availableAuthors.some((a) => a.id === id)) return;
    availableAuthors = [
      ...availableAuthors,
      { id, name: post.author?.displayName || post.author?.name || id, email: "" },
    ];
  }

  /**
   * Tags and games come from kon-games. If the admin has it turned off (we
   * know this from /api/modules), requesting them only produced two 404s on each opening of the
   * editor. The editor cannot read /api/modules: for it, they are tried anyway.
   */
  async function hasGameKon(): Promise<boolean> {
    if (!isAdmin()) return true;
    // Joins the request the layout already made: a second `fetchModules()` here superseded
    // it, came back with the list still empty, and "empty" was read as "may be on".
    await moduleStore.whenLoaded();
    // No list at all (the request failed): unknown, so they are tried, as for the editor.
    if (!moduleStore.loaded) return true;
    return moduleStore.activeKon("kon-games");
  }

  // ─── Helpers ────────────────────────────────────────
  function generateSlug(text: string) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function handleTitleChange() {
    if (!slug && title) {
      slug = generateSlug(title);
    }
  }

  function selectFeaturedImage(media: { id: string; url: string }) {
    featuredImageId = media.id;
    featuredImageUrl = media.url;
    showMediaModal = false;
  }

  /**
   * Files pasted or dragged onto the editor.
   *
   * It goes direct: they are uploaded and inserted without going through the library.
   * Opening the picker after someone has pasted a screenshot would be asking them
   * to choose again what they just handed over.
   *
   * `imageTarget` is set to "contenido" because `chooseImage` decides with
   * it, and if the modal's last use was the cover, the pasted screenshot
   * would have gone to the featured image.
   */
  async function uploadFilesToContent(files: File[]) {
    if (files.length === 0) return;

    // `imageTarget` decides where it goes in `chooseImage`. If the last use
    // of the picker was the cover, without this the pasted screenshot would have gone to
    // the featured image.
    imageTarget = "contenido";
    uploadError = null;
    uploadingImage = true;

    try {
      const { uploaded, errors: errors } = await uploadMedia(files);
      if (errors.length > 0) uploadError = errors.join(" · ");
      if (uploaded[0]) chooseImage(uploaded[0]);
    } catch (err) {
      uploadError = err instanceof Error ? err.message : tr("blogPostEditor.couldNotUpload");
    } finally {
      uploadingImage = false;
    }
  }

  /** Opens the library to put an image IN THE TEXT. */
  function requestImageForContent() {
    // The cursor is noted BEFORE opening the modal. As soon as the modal focuses its
    // search box, the textarea loses focus and its `selectionStart` stops being valid;
    // without this line the image was inserted at the start of the article.
    //
    // Markdown mode does not need it: CodeMirror keeps its own selection
    // even when it loses focus.
    quickEditor?.rememberPosition();

    imageTarget = "contenido";
    uploadError = null;
    showMediaModal = true;
  }

  /** Opens the library for the COVER image. */
  function requestCoverImage() {
    imageTarget = "portada";
    uploadError = null;
    showMediaModal = true;
  }

  /**
   * An image chosen from the library. Where it goes is decided by `imageTarget`.
   *
   * The `alt` comes from whatever the file already has in the library. It is what
   * makes inserting from here better than writing the markdown by hand: by hand,
   * the `alt` almost always stays as «alt» — and `alt` is accessibility and
   * SEO, two of the things this editor measures in its own score.
   */
  function chooseImage(media: { id: string; url: string; filename: string; alt?: string }) {
    if (imageTarget === "portada") {
      selectFeaturedImage(media);
      return;
    }

    const textValue = media.alt || media.filename.replace(/\.[^.]+$/, "");
    const editor = contentMode === "markdown" ? editorMarkdown : quickEditor;
    editor?.insertImage(media.url, textValue);
    showMediaModal = false;
  }

  function removeFeaturedImage() {
    featuredImageId = "";
    featuredImageUrl = "";
  }

  function toggleTag(tag: { id: string; name: string; slug: string }) {
    const exists = tags.find((t) => t.id === tag.id);
    if (exists) {
      tags = tags.filter((t) => t.id !== tag.id);
    } else {
      tags = [...tags, tag];
    }
  }

  async function createNewTag() {
    if (!newTagName.trim()) return;

    try {
      const slug = generateSlug(newTagName);
      const newTag = await api.createTag({
        name: newTagName.trim(),
        slug,
      });
      availableTags = [...availableTags, newTag];
      tags = [...tags, newTag];
      newTagName = "";
    } catch (err: any) {
      error = err.message || tr("blogPostEditor.failedToCreateTag");
    }
  }

  async function handleSave() {
    if (!title.trim()) {
      error = tr("blogPostEditor.titleIsRequired");
      return;
    }

    saving = true;
    error = null;

    try {
      /**
       * The body has to fit the API's `createPostSchema`, and it
       * did not. Three mismatches, checked by passing this very object through
       * the real schema:
       *
       *   · `publishedAt: null` and `featuredImageId: null` → **400**. The schema
       *     declares them `.optional()`, which in zod means `undefined`, NOT
       *     `null`. Saving a DRAFT WITHOUT AN IMAGE —the most common case, a new
       *     post— always failed with «Validation failed».
       *   · `tags` does not exist in the schema: it is called `tagIds`. Zod drops
       *     keys it does not know instead of complaining, so tags
       *     vanished SILENTLY. That one is worse than the 400: the post is saved
       *     and the tags are not, without a single warning.
       *
       * That is why optionals are OMITTED when there is no value, instead of
       * being sent as `null`.
       */
      const postData: Record<string, unknown> = {
        title: title.trim(),
        slug: slug || generateSlug(title),
        content,
        // Blocks travel with the post: without this, the blocks tab would be
        // decorative — they would be edited and not saved.
        blocks,
        excerpt: excerpt.trim(),
        status,
        // Without this line the switch would be decorative: Zod silently drops
        // what does not arrive, so closing the thread would give no
        // error and the post would be saved with comments open.
        commentsEnabled,
        // Same as above: without this line the selector would be decorative.
        layout,
        /**
         * And the same with language: without these two lines, marking an article
         * as English would save it as Spanish —the column has DEFAULT
         * 'es'— without any error.
         */
        locale,
        translationGroupId: translationGroupId.trim() || null,
        seoOverrides: {
          metaTitle: seoOverrides.metaTitle || null,
          metaDescription: seoOverrides.metaDescription || null,
          ogTitle: seoOverrides.ogTitle || null,
          ogDescription: seoOverrides.ogDescription || null,
          ogImageId: seoOverrides.ogImageId || null,
          canonicalUrl: seoOverrides.canonicalUrl || null,
          robotsIndex: seoOverrides.robotsIndex,
          robotsFollow: seoOverrides.robotsFollow,
          structuredData: seoOverrides.structuredData || null,
          facebookGroupUrl: seoOverrides.facebookGroupUrl.trim() || null,
          whatsappGroupUrl: seoOverrides.whatsappGroupUrl.trim() || null,
        },
      };

      const publishDate =
        status === "scheduled"
          ? new Date(publishedAt).toISOString()
          : status === "published"
            ? new Date().toISOString()
            : null;

      if (publishDate) postData.publishedAt = publishDate;
      if (featuredImageId) postData.featuredImageId = featuredImageId;
      if (authorId) postData.authorId = authorId;
      if (tags.length > 0) postData.tagIds = tags.map((t) => t.id);

      // Categories ARE sent empty: `[]` means «remove them all», and
      // omitting them means «don't touch them». They are different things and the API
      // tells them apart (`categoryIds !== undefined`). With tags the same
      // cannot be done without changing the existing contract.
      if (postId || categoryIds.length > 0) postData.categoryIds = categoryIds;

      // Same treatment as categories: `[]` removes all, omitting it touches nothing.
      // …but only what was really loaded: see `gameIdsLoaded`.
      if (gameKonOn && (postId ? gameIdsLoaded : gameIds.length > 0)) postData.gameIds = gameIds;

      if (postId) {
        if (loadedVersion) postData.expectedUpdatedAt = loadedVersion;
        await api.updatePost(postId, postData as any);
      } else {
        await api.createPost(postData as any);
      }

      // Saved on the server: the local draft is no longer needed and leaving it
      // would make the next opening offer to recover something already saved.
      autosaveStore.clearCurrentAutosave();

      goto("/g/kon-blog");
    } catch (err: any) {
      /**
       * 409 is not a failure: it is «someone else saved before you, and I have not
       * written anything so as not to erase their work».
       *
       * It is handled separately because the reaction is different: there is nothing to
       * retry, you have to see what changed. And above all the local draft is NOT
       * cleared — it is the only thing that keeps what was just written.
       */
      const failure = err as ApiError;
      if (failure.status === 409) {
        const body = failure.body as { message?: string; currentUpdatedAt?: string } | undefined;
        conflict = {
          message: body?.message || failure.message,
          when: body?.currentUpdatedAt ?? null,
        };
      } else {
        error = failure.message || tr("blogPostEditor.failedToSavePost");
      }
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    if (!(await confirmDialog(tr("blogPostEditor.areYouSureYouWant")))) return;

    try {
      await api.deletePost(postId!);
      goto("/g/kon-blog");
    } catch (err: any) {
      error = err.message || tr("blogPostEditor.failedToDeletePost");
    }
  }

  /*
   * `handlePreview` has been removed.
   *
   * It opened `/blog/<slug>?preview=true` in another tab, and that route DOES NOT EXIST:
   * the repo only has `apps/api`, there is no public site. Checked against
   * the installation: `:3001/blog/whatever` returns 200 because nginx serves the
   * panel for any route, so a tab opened with the panel itself
   * on a route its router does not know.
   *
   * And NOBODY called it: the header's «Preview» button toggles
   * `showPreview`, which is the side panel right next to it. It was a dead function
   * pointing to a nonexistent page — exactly what someone ends up
   * hooking to a button one day, believing there is a public preview.
   *
   * When a frontend exists, this is the place for it.
   */

  function handleDatasetSelect(data: {
    title: string;
    content: string;
    excerpt: string;
    featuredImageId?: string;
    tags: string[];
    source: {
      type: "dataset";
      datasetId: string;
      entryId: string;
    };
  }) {
    // Populate form with dataset entry data
    title = data.title;
    slug = generateSlug(data.title);
    content = data.content;
    excerpt = data.excerpt;
    featuredImageId = data.featuredImageId || "";

    // Generate tags from dataset entry
    // Note: These are tag names, we'd need to create/fetch actual tag objects
    // For now, we'll store them as placeholder tags
    tags = data.tags.map((tagName, index) => ({
      id: `temp-${index}`,
      name: tagName,
      slug: tagName.toLowerCase().replace(/\s+/g, "-"),
    }));

    // Optionally set SEO defaults
    if (!seoOverrides.metaTitle) {
      seoOverrides.metaTitle = data.title;
    }
    if (!seoOverrides.metaDescription) {
      seoOverrides.metaDescription = data.excerpt.substring(0, 160);
    }
  }

  function formatDateForInput(date: string): string {
    if (!date) return "";
    const d = new Date(date);
    return d.toISOString().slice(0, 16);
  }
</script>

<PageCrumbs
  crumbs={[
    { label: title.trim() || (postId ? tr("blogPostEditor.editPost") : tr("common.newPost")) },
  ]}
/>

<div class="h-[calc(100dvh-6.5rem)] flex flex-col bg-kitsuden-bg">
  <!-- Header -->
  <header
    class="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-kitsuden-border bg-kitsuden-card shrink-0"
  >
    <div class="flex items-center gap-4">
      <Button href="/g/kon-blog" variant="ghost" size="icon" class="hover:bg-kitsuden-border/50">
        <ArrowLeft class="w-5 h-5" />
      </Button>
      <div>
        <h1 class="text-xl font-bold text-kitsuden-text flex items-center gap-3">
          <div
            class="w-9 h-9 rounded-xl bg-linear-to-br from-kitsuden-green/20 to-kitsuden-accent/20 border border-kitsuden-green/20 flex items-center justify-center"
          >
            <FileText class="w-4 h-4 text-kitsuden-green" />
          </div>
          {postId ? tr("blogPostEditor.editPost") : tr("common.newPost")}
        </h1>
        <p class="text-xs text-kitsuden-subtle mt-0.5">
          {seoScore >= 80
            ? tr("blogPostEditor.seoOptimized")
            : seoScore >= 50
              ? tr("blogPostEditor.seoNeedsImprovement")
              : tr("blogPostEditor.seoIncomplete")} •
          <span
            class={seoScore >= 80
              ? "text-kitsuden-green"
              : seoScore >= 50
                ? "text-kitsuden-amber"
                : "text-kitsuden-accent-2"}
          >
            {tr("blogPostEditor.score", { seoScore })}
          </span>
        </p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <!--
        State of the LOCAL DRAFT, not of the post. The distinction matters: «Saved»
        here means «there is a copy in this browser», not «it is published». That is
        why the indicator is separate from the save button and not in its place.
      -->
      <AutoSaveIndicator />
      {#if !postId}
        <!-- New Post Options -->
        <Button variant="ghost" size="sm" onclick={() => (showDatasetModal = true)}>
          <Database class="w-4 h-4" />
          {tr("blogPostEditor.fromDataset")}
        </Button>
      {/if}
      <Button variant="ghost" size="sm" onclick={() => (showPreview = !showPreview)}>
        {#if showPreview}
          <EyeOff class="w-4 h-4" />
          {tr("blogPostEditor.hidePreview")}
        {:else}
          <Eye class="w-4 h-4" />
          {tr("common.preview")}
        {/if}
      </Button>
      {#if postId}
        <Button variant="danger-ghost" size="sm" onclick={handleDelete}>
          <Trash2 class="w-4 h-4" />
          {tr("common.delete")}
        </Button>
      {/if}
      <Button size="sm" onclick={handleSave} loading={saving} disabled={saving}>
        {#if saving}
          {tr("common.saving")}
        {:else}
          <Save class="w-4 h-4" />
          {tr("blogPostEditor.savePost")}
        {/if}
      </Button>
    </div>
  </header>

  {#if pendingDraft}
    <!--
      There is a local copy newer than what is saved on the server. It is NOT applied
      by itself: overwriting what the person just opened without asking is
      exactly the class of loss this comes to prevent.
    -->
    <div class="px-4 sm:px-6 pt-3 shrink-0">
      <Alert variant="warning">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span class="flex min-w-0 items-start gap-2">
            <History class="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {tr("blogPostEditor.hasUnsavedChangesOf")}
              <strong>{new Date(pendingDraft.when).toLocaleString(localeFormat())}</strong>
              {tr("blogPostEditor.inThisBrowserRecoverThem")}
            </span>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            <Button size="sm" onclick={recoverDraft}>{tr("blogPostEditor.recover")}</Button>
            <Button variant="ghost" size="sm" onclick={discardDraft}
              >{tr("blogPostEditor.discard")}</Button
            >
          </span>
        </div>
      </Alert>
    </div>
  {/if}

  {#if conflict}
    <!--
      409: someone else saved while this editor was open. Nothing has been
      written. The editor's text is still on screen and in the local draft,
      so nothing is lost on reloading in another tab.
    -->
    <div class="px-4 sm:px-6 pt-3 shrink-0">
      <Alert
        variant="error"
        title={tr("blogPostEditor.thePostHasChangedSince")}
        onDismiss={() => (conflict = null)}
        dismissLabel={tr("sidebarLayout.closeNotification")}
      >
        <p class="text-xs mt-0.5">
          {conflict.message}
          {#if conflict.when}
            {tr("blogPostEditor.lastSaved", {
              v: new Date(conflict.when).toLocaleString(localeFormat()),
            })}
          {/if}
        </p>
      </Alert>
    </div>
  {/if}

  <!-- Tabs: only the tablist; each panel below carries role="tabpanel" and its id. -->
  <Tabs
    items={EDITOR_TABS}
    bind:value={() => activeTab, (v) => (activeTab = v as typeof activeTab)}
    panels={false}
    ariaLabel={tr("blogPostEditor.editorSections")}
    class="px-6 pt-1 bg-kitsuden-card/50 shrink-0"
  >
    {#snippet tab(item)}
      {@const Icon = TAB_ICONS[item.id as typeof activeTab]}
      <Icon class="w-4 h-4" />
      {item.label}
      {#if item.id === "blocks" && blocks.length > 0}
        <Badge variant="secondary">{blocks.length}</Badge>
      {:else if item.id === "seo"}
        {#if seoScore < 80}
          <Badge variant="accent-2" dot>{seoScore}</Badge>
        {:else}
          <CheckCircle2 class="w-3.5 h-3.5 text-kitsuden-green" />
        {/if}
      {/if}
    {/snippet}
  </Tabs>

  <!-- Error Alert -->
  {#if error}
    <div class="mx-6 mt-4 shrink-0">
      <Alert variant="error" onDismiss={() => (error = null)}>{error}</Alert>
    </div>
  {/if}

  <!-- Content Area -->
  {#if loading}
    <div class="flex-1 flex items-center justify-center">
      <div class="flex flex-col items-center gap-3">
        <Spinner
          size="lg"
          label={tr("blogPostEditor.loadingEditor")}
          class="text-kitsuden-accent"
        />
        <p class="text-kitsuden-subtle text-sm" aria-hidden="true">
          {tr("blogPostEditor.loadingEditor")}
        </p>
      </div>
    </div>
  {:else}
    {#snippet editorPanels()}
      <!-- TAB: Content -->
      {#if activeTab === "content"}
        <div
          id="post-panel-content"
          role="tabpanel"
          aria-labelledby="post-tab-content"
          tabindex="-1"
          class="h-full grid grid-cols-1 lg:grid-cols-3 gap-0"
        >
          <!-- Main Editor -->
          <div class="lg:col-span-2 h-full overflow-y-auto p-6">
            <div class="max-w-3xl mx-auto space-y-6">
              <!-- Title -->
              <div>
                <Label for="title" class="mb-2 block">
                  {tr("blogPostEditor.postTitle")}
                </Label>
                <Input
                  class="text-2xl! font-bold! py-3!"
                  id="title"
                  type="text"
                  bind:value={title}
                  oninput={handleTitleChange}
                  placeholder={tr("blogPostEditor.enterAnEngagingTitle")}
                />
                <div class="flex justify-between mt-1.5">
                  <span class="text-xs text-kitsuden-subtle">
                    {tr("blogPostEditor.characters", { titleCount: title.length })}
                  </span>
                  <span
                    class="text-xs {title.length >= 30 && title.length <= 60
                      ? 'text-kitsuden-green'
                      : 'text-kitsuden-accent-2'}"
                  >
                    {tr("blogPostEditor.optimal3060Chars")}
                  </span>
                </div>
              </div>

              <!-- Slug -->
              <div>
                <Label for="slug" class="mb-2 block">{tr("blogPostEditor.urlSlug")}</Label>
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-kitsuden-subtle text-sm font-mono shrink-0"
                    >{tr("blogPostEditor.blog")}</span
                  >
                  <Input
                    id="slug"
                    type="text"
                    bind:value={slug}
                    placeholder="your-post-slug"
                    class="flex-1 min-w-0 font-mono"
                  />
                </div>
              </div>

              <!-- Content Editor -->
              <div>
                <div class="mb-2 flex items-center justify-between gap-3">
                  <Label class="block">
                    {tr("common.content")}
                  </Label>

                  <div class="flex items-center gap-2">
                    <!--
                      ── WHY IT IS HERE AND NOT IN THE EDITOR BAR ────────────

                      Because it has to appear in BOTH modes. The quick mode
                      has a toolbar and the markdown one is CodeMirror
                      and does not; a button that appears and disappears when switching
                      modes is worse than one that is always in the same place.

                      (The quick mode also has it in its bar and in `/image`,
                      which is where the hand goes by itself.)
                    -->
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={requestImageForContent}
                      title={tr("blogPostEditor.insertAnImageFrom")}
                    >
                      <Image class="h-3.5 w-3.5" />
                      {tr("blogPostEditor.image")}
                    </Button>

                    <!--
                      Two ways of writing the SAME field. Nothing is lost on
                      switching: both editors emit plain-text markdown.
                    -->
                    <ToggleGroup
                      options={[
                        { value: "markdown", label: tr("common.markdown") },
                        { value: "fast", label: tr("blogPostEditor.fast") },
                      ]}
                      bind:value={() => contentMode, (v) => (contentMode = v as typeof contentMode)}
                      required
                      size="sm"
                      ariaLabel={tr("blogPostEditor.writingMode")}
                    />
                  </div>
                </div>

                {#if contentMode === "markdown"}
                  <div class="h-128 overflow-hidden rounded-lg border border-kitsuden-border">
                    <MdxEditor
                      bind:this={editorMarkdown}
                      value={content}
                      onChange={(v) => (content = v)}
                      onUploadFiles={uploadFilesToContent}
                    />
                  </div>
                {:else}
                  <SlashCommandEditor
                    bind:this={quickEditor}
                    value={content}
                    onChange={(v) => (content = v)}
                    onRequestImage={requestImageForContent}
                    onUploadFiles={uploadFilesToContent}
                    placeholder={tr("blogPostEditor.startWritingTypeForCommands")}
                  />
                {/if}

                <!--
                  ── UPLOAD NOTICE, OUTSIDE THE MODAL ────────────────────────

                  When pasting a screenshot the modal is CLOSED, so its
                  indicator is not visible: for two or three seconds nothing
                  happened on screen and the gesture seemed not to have worked —
                  which is how people paste the same image three times.

                  It is rendered only when the modal is not open, so as not to
                  duplicate the notice when the upload does come from there.
                -->
                {#if !showMediaModal && (uploadingImage || uploadError)}
                  <div class="mt-2 text-xs">
                    {#if uploadingImage}
                      <span class="flex items-center gap-1.5 text-kitsuden-subtle">
                        <Spinner size="sm" label={tr("blogPostEditor.uploadingImage")} />
                        <span aria-hidden="true">{tr("blogPostEditor.uploadingImage")}</span>
                      </span>
                    {:else}
                      <span class="flex items-center gap-1.5 text-kitsuden-danger">
                        <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
                        {uploadError}
                      </span>
                    {/if}
                  </div>
                {/if}
              </div>

              <!--
                The featured image and the excerpt go AFTER the body.

                They used to come before, so the field where the post is written —the
                only thing you really come here to do— was the fourth and
                below the fold: you opened «New Post» and could not see
                where to write. They are metadata; the body is the content.
              -->
              <!-- Featured Image -->
              <div>
                <Label class="mb-2 block">
                  {tr("blogPostEditor.featuredImage")}
                </Label>
                {#if featuredImageUrl}
                  <div class="relative rounded-xl overflow-hidden border border-kitsuden-border">
                    <img
                      src={mediaUrl(featuredImageUrl)}
                      alt={tr("blogPostEditor.featured")}
                      class="w-full h-48 object-cover"
                    />
                    <Button
                      variant="secondary"
                      size="icon"
                      class="absolute top-2 right-2"
                      onclick={removeFeaturedImage}
                      ariaLabel={tr("blogPostEditor.removeFeaturedImage")}
                      title={tr("blogPostEditor.removeFeaturedImage")}
                    >
                      <X class="w-4 h-4" />
                    </Button>
                  </div>
                {:else}
                  <Button
                    variant="outline"
                    class="w-full flex-col! gap-3! p-8! rounded-xl! border-2! border-dashed! border-kitsuden-border! hover:border-kitsuden-accent/50!"
                    onclick={requestCoverImage}
                  >
                    <Image class="w-8 h-8 text-kitsuden-subtle" />
                    <span class="text-sm text-kitsuden-subtle"
                      >{tr("blogPostEditor.clickToSelectFeaturedImage")}</span
                    >
                    <span class="text-xs text-kitsuden-subtle"
                      >{tr("blogPostEditor.recommended1200x630px")}</span
                    >
                  </Button>
                {/if}
              </div>

              <!-- Excerpt -->
              <div>
                <Label for="excerpt" class="mb-2 block">
                  {tr("blogPostEditor.excerptSummary")}
                </Label>
                <Textarea
                  class="resize-none!"
                  id="excerpt"
                  bind:value={excerpt}
                  rows={3}
                  placeholder={tr("blogPostEditor.briefSummaryOfYourPost")}
                />
                <div class="flex justify-between mt-1.5">
                  <span class="text-xs text-kitsuden-subtle">
                    {tr("blogPostEditor.characters2", { excerptCount: excerpt.length })}
                  </span>
                  <span
                    class="text-xs {excerpt.length >= 120 && excerpt.length <= 160
                      ? 'text-kitsuden-green'
                      : 'text-kitsuden-amber'}"
                  >
                    {tr("blogPostEditor.optimal120160Chars")}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Sidebar -->
          <div
            class="h-full overflow-y-auto border-l border-kitsuden-border bg-kitsuden-card/30 p-6"
          >
            <div class="space-y-6">
              <!-- Status -->
              <Card>
                <CardHeader>
                  <CardTitle level={3} class="flex items-center gap-2">
                    <Settings class="w-4 h-4" />
                    {tr("blogPostEditor.publishing")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div class="space-y-4">
                    <div>
                      <Label for="status" class="mb-1.5 block">{tr("common.status")}</Label>
                      <Select id="status" bind:value={status}>
                        <option value="draft">{tr("blogPostEditor.draft")}</option>
                        <option value="scheduled">{tr("blogPostEditor.scheduled")}</option>
                        <option value="published">{tr("blogPostEditor.published")}</option>
                        <option value="archived">{tr("blogPostEditor.archived")}</option>
                      </Select>
                    </div>

                    <!--
                    ── THE SWITCH THAT WAS MISSING ─────────────────────────────

                    The column, the API and the block existed, and there was no way to
                    touch it from the panel: closing an article's thread could only be done
                    with a manual PATCH. In WordPress this is the «Discussion» box
                    of old.
                  -->
                    <div>
                      <Checkbox bind:checked={commentsEnabled} class="text-xs!"
                        >{tr("blogPostEditor.allowComments")}</Checkbox
                      >
                      <p class="text-xs text-kitsuden-subtle mt-1">
                        {commentsEnabled
                          ? tr("blogPostEditor.readersCanCommentAnd")
                          : tr("blogPostEditor.closedThreadAlreadyWritten")}
                      </p>
                    </div>

                    <!--
                    Language and translations.

                    One entry per language, tied by a group. To translate
                    an article, another is created, given its language, and the original's group
                    is pasted here; the button copies the group of the open article,
                    which is where you always start.
                  -->
                    <div>
                      <Label for="locale" class="mb-1.5 block">{tr("common.language")}</Label>
                      <Select id="locale" bind:value={locale}>
                        {#each PANEL_LANGUAGES as language (language.code)}
                          <option value={language.code}>{language.name}</option>
                        {/each}
                      </Select>
                      <p class="text-xs text-kitsuden-subtle mt-1">
                        {tr("blogPostEditor.theWebShowsAVersion")}
                      </p>
                    </div>

                    <div>
                      <Label for="translation-group" class="mb-1.5 block">
                        {tr("blogPostEditor.groupTranslation")}
                      </Label>
                      <Input
                        class="font-mono! text-xs!"
                        id="translation-group"
                        type="text"
                        bind:value={translationGroupId}
                        placeholder={tr("blogPostEditor.emptyLooseArticle")}
                      />
                      <p class="text-xs text-kitsuden-subtle mt-1">
                        {tr("blogPostEditor.pasteHereTheGroupOf")}
                      </p>
                      {#if postId}
                        <Button
                          variant="secondary"
                          size="sm"
                          class="mt-2"
                          type="button"
                          onclick={() => (translationGroupId = translationGroupId || postId)}
                        >
                          {tr("blogPostEditor.useThisArticleAsOriginal")}
                        </Button>
                      {/if}
                    </div>

                    <div>
                      <Label for="layout" class="mb-1.5 block"
                        >{tr("blogPostEditor.template")}</Label
                      >
                      <Select id="layout" bind:value={layout}>
                        <option value="article">{tr("blogPostEditor.article")}</option>
                        <option value="tips"
                          >{tr("blogPostEditor.tipsNumberedListWithIndex")}</option
                        >
                      </Select>
                      <p class="text-xs text-kitsuden-subtle mt-1">
                        {layout === "tips"
                          ? tr("blogPostEditor.eachH2TitleOfContent")
                          : tr("blogPostEditor.theUsualArticleTo")}
                      </p>
                    </div>

                    {#if status === "scheduled"}
                      <div>
                        <Label for="publishedat" class="mb-1.5 flex! items-center gap-1">
                          <Calendar class="w-3 h-3" />
                          {tr("blogPostEditor.publishDate")}
                        </Label>
                        <Input
                          class="text-sm!"
                          id="publishedat"
                          type="datetime-local"
                          bind:value={publishedAt}
                        />
                      </div>
                    {/if}

                    <div>
                      <Label for="authorid" class="mb-1.5 flex! items-center gap-1">
                        <User class="w-3 h-3" />
                        {tr("common.author")}
                      </Label>
                      <Select id="authorid" bind:value={authorId}>
                        <option value="">{tr("blogPostEditor.selectAuthor")}</option>
                        {#each availableAuthors as author}
                          <option value={author.id}>{author.name}</option>
                        {/each}
                      </Select>
                    </div>
                  </div>
                </CardContent></Card
              >

              <!--
                Categories: the HIERARCHICAL taxonomy. It goes above the tags
                on purpose — it is what decides where the post lives; tags
                only describe it.
              -->
              <Card>
                <CardHeader>
                  <CardTitle level={3} class="flex items-center gap-2">
                    <FolderTree class="w-4 h-4" />
                    {tr("blogPostEditor.categories")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {#if availableCategories.length === 0}
                    <p class="text-xs text-kitsuden-subtle italic mb-3">
                      {tr("blogPostEditor.noCategoriesYet")}
                    </p>
                  {:else}
                    <div class="space-y-1 mb-3 max-h-56 overflow-y-auto">
                      {#each availableCategories as cat (cat.id)}
                        <div class="py-1" style="padding-left: {depthOf(cat) * 16}px">
                          <Checkbox
                            checked={categoryIds.includes(cat.id)}
                            onchange={() => toggleCategory(cat.id)}
                          >
                            <span>{cat.name}</span>
                            {#if cat.postCount}
                              <span class="text-xs text-kitsuden-subtle">({cat.postCount})</span>
                            {/if}
                          </Checkbox>
                        </div>
                      {/each}
                    </div>
                  {/if}

                  <Button
                    variant="ghost"
                    size="sm"
                    class="w-full"
                    onclick={() => (showCategoryModal = true)}
                  >
                    <Plus class="w-3 h-3" />
                    {tr("blogPostEditor.newCategory")}
                  </Button>
                </CardContent></Card
              >

              <!--
                Games: this is where the heart the cover puts on the card comes from
                and which leads to the game's screen. The relation already
                existed in the API; what was missing was being able to choose it.
              -->
              <Card>
                <CardHeader>
                  <CardTitle level={3} class="flex items-center gap-2">
                    <Gamepad2 class="w-4 h-4" />
                    {tr("blogPostEditor.games")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {#if availableGames.length === 0}
                    <p class="text-xs text-kitsuden-subtle italic">
                      {tr("blogPostEditor.noGamesToChoose")}
                    </p>
                  {:else}
                    <div class="space-y-1 max-h-56 overflow-y-auto">
                      {#each availableGames as game (game.id)}
                        <div class="py-1">
                          <Checkbox
                            checked={gameIds.includes(game.id)}
                            onchange={() => toggleGame(game.id)}
                          >
                            {game.title}
                          </Checkbox>
                        </div>
                      {/each}
                    </div>
                    <p class="text-xs text-kitsuden-subtle mt-2">
                      {tr("blogPostEditor.inHomeTheCard")}
                    </p>
                  {/if}
                </CardContent></Card
              >

              <!-- Tags -->
              <Card>
                <CardHeader>
                  <CardTitle level={3} class="flex items-center gap-2">
                    <Tag class="w-4 h-4" />
                    {tr("common.tags")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div class="flex flex-wrap gap-2 mb-3">
                    {#each tags as tag}
                      <Badge variant="accent">
                        {tag.name}
                        <button
                          type="button"
                          onclick={() => toggleTag(tag)}
                          class="hover:text-kitsuden-accent-2"
                          aria-label={tr("blogPostEditor.removeTag", { name: tag.name })}
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </Badge>
                    {/each}
                    {#if tags.length === 0}
                      <span class="text-xs text-kitsuden-subtle italic"
                        >{tr("blogPostEditor.noTagsSelected")}</span
                      >
                    {/if}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    class="w-full"
                    onclick={() => (showTagModal = true)}
                  >
                    <Plus class="w-3 h-3" />
                    {tr("blogPostEditor.addTags")}
                  </Button>
                </CardContent></Card
              >

              <!-- SEO Summary -->
              <Card>
                <CardHeader>
                  <CardTitle level={3} class="flex items-center gap-2">
                    <Search class="w-4 h-4" />
                    {tr("blogPostEditor.seoSummary")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div class="space-y-2">
                    <Progress
                      value={seoScore}
                      label={tr("common.score")}
                      showValue
                      variant={seoScore >= 80 ? "success" : seoScore >= 50 ? "warning" : "error"}
                    />
                    <Button
                      variant="soft"
                      size="sm"
                      class="mt-2"
                      onclick={() => (activeTab = "seo")}
                    >
                      {tr("blogPostEditor.improveSeo")}
                    </Button>
                  </div>
                </CardContent></Card
              >
            </div>
          </div>
        </div>
      {/if}

      <!--
        TAB: Blocks

        Its own tab and not a writing mode, because it is NOT the same data: the
        text lives in `content` and the blocks in the `blocks` column (jsonb).
        Both are saved with the post.
      -->
      {#if activeTab === "blocks"}
        <div
          id="post-panel-blocks"
          role="tabpanel"
          aria-labelledby="post-tab-blocks"
          tabindex="-1"
          class="h-full overflow-y-auto p-6"
        >
          <PageBuilder {blocks} onChange={(b) => (blocks = b)} />
        </div>
      {/if}

      <!-- TAB: SEO -->
      {#if activeTab === "seo"}
        <div
          id="post-panel-seo"
          role="tabpanel"
          aria-labelledby="post-tab-seo"
          tabindex="-1"
          class="h-full overflow-y-auto p-6"
        >
          <div class="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
            <!-- SEO Form -->
            <div class="space-y-6">
              <div>
                <h2 class="text-lg font-semibold text-kitsuden-text mb-1">
                  {tr("blogPostEditor.seoSettings")}
                </h2>
                <p class="text-sm text-kitsuden-subtle">
                  {tr("blogPostEditor.optimizeYourPostForSearch")}
                </p>
              </div>

              <!-- Meta Title -->
              <div>
                <div class="flex items-center justify-between mb-2">
                  <Label for="metatitle">{tr("blogPostEditor.metaTitle")}</Label>
                  <span
                    class="text-xs {(seoOverrides.metaTitle || title).length <= 60
                      ? 'text-kitsuden-green'
                      : 'text-kitsuden-accent-2'}"
                  >
                    {(seoOverrides.metaTitle || title).length}/60
                  </span>
                </div>
                <Input
                  id="metatitle"
                  type="text"
                  bind:value={seoOverrides.metaTitle}
                  placeholder={title}
                />
                <p class="text-xs text-kitsuden-subtle mt-1">
                  {tr("blogPostEditor.leaveEmptyToUsePost")}
                </p>
              </div>

              <!-- Meta Description -->
              <div>
                <div class="flex items-center justify-between mb-2">
                  <Label for="metadescription">{tr("blogPostEditor.metaDescription")}</Label>
                  <span
                    class="text-xs {(seoOverrides.metaDescription || excerpt).length <= 160
                      ? 'text-kitsuden-green'
                      : 'text-kitsuden-accent-2'}"
                  >
                    {(seoOverrides.metaDescription || excerpt).length}/160
                  </span>
                </div>
                <Textarea
                  class="resize-none!"
                  id="metadescription"
                  bind:value={seoOverrides.metaDescription}
                  rows={3}
                  placeholder={excerpt}
                />
              </div>

              <!-- Canonical URL -->
              <div>
                <Label for="canonicalurl" class="mb-2 block"
                  >{tr("blogPostEditor.canonicalUrl")}</Label
                >
                <Input
                  id="canonicalurl"
                  type="url"
                  bind:value={seoOverrides.canonicalUrl}
                  placeholder="https://yoursite.com/blog/{slug}"
                />
              </div>

              <!-- Robots -->
              <Card>
                <CardHeader>
                  <CardTitle level={3}>
                    {tr("blogPostEditor.robotsMeta")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div class="space-y-3">
                    <Checkbox
                      bind:checked={
                        () => seoOverrides.robotsIndex ?? true,
                        (v) => (seoOverrides.robotsIndex = v)
                      }>{tr("blogPostEditor.allowSearchEnginesToIndex")}</Checkbox
                    >
                    <Checkbox
                      bind:checked={
                        () => seoOverrides.robotsFollow ?? true,
                        (v) => (seoOverrides.robotsFollow = v)
                      }>{tr("blogPostEditor.allowSearchEnginesToFollow")}</Checkbox
                    >
                  </div>
                </CardContent></Card
              >

              <!-- OG Settings -->
              <Card>
                <CardHeader>
                  <CardTitle level={3} class="flex items-center gap-2">
                    <Share2 class="w-4 h-4" />
                    {tr("blogPostEditor.socialSharingOpenGraph")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div class="space-y-4">
                    <div>
                      <Label for="ogtitle" class="mb-1.5 block"
                        >{tr("blogPostEditor.ogTitle")}</Label
                      >
                      <Input
                        class="text-sm!"
                        id="ogtitle"
                        type="text"
                        bind:value={seoOverrides.ogTitle}
                        placeholder={seoOverrides.metaTitle || title}
                      />
                    </div>

                    <div>
                      <Label for="ogdescription" class="mb-1.5 block"
                        >{tr("blogPostEditor.ogDescription")}</Label
                      >
                      <Textarea
                        class="text-sm! resize-none!"
                        id="ogdescription"
                        bind:value={seoOverrides.ogDescription}
                        rows={2}
                        placeholder={seoOverrides.metaDescription || excerpt}
                      />
                    </div>
                  </div>
                </CardContent></Card
              >
            </div>

            <!-- Previews -->
            <div class="space-y-6">
              <div>
                <h2 class="text-lg font-semibold text-kitsuden-text mb-1">
                  {tr("blogPostEditor.previews")}
                </h2>
                <p class="text-sm text-kitsuden-subtle">
                  {tr("blogPostEditor.seeHowYourPostWill")}
                </p>
              </div>

              <!-- Google Preview -->
              <div>
                <h3 class="text-xs font-medium text-kitsuden-subtle uppercase tracking-wider mb-3">
                  {tr("blogPostEditor.googleSearch")}
                </h3>
                <div class="bg-white rounded-lg p-4 font-sans">
                  <p class="text-[#1a0dab] text-lg truncate hover:underline cursor-pointer">
                    {metaTitlePreview || tr("blogPostEditor.postTitle")}
                  </p>
                  <p class="text-[#006621] text-xs mt-0.5">
                    {tr("blogPostEditor.yoursiteComBlog")}
                    {slug || "post-slug"}
                  </p>
                  <p class="text-[#545454] text-xs mt-1 line-clamp-2">
                    {metaDescPreview || tr("blogPostEditor.addAMetaDescriptionTo")}
                  </p>
                </div>
              </div>

              <!-- Social Preview -->
              <div>
                <h3 class="text-xs font-medium text-kitsuden-subtle uppercase tracking-wider mb-3">
                  {tr("blogPostEditor.socialShare")}
                </h3>
                <div
                  class="rounded-lg overflow-hidden border border-kitsuden-border bg-kitsuden-card max-w-md"
                >
                  {#if featuredImageUrl}
                    <img src={mediaUrl(featuredImageUrl)} alt="" class="w-full h-48 object-cover" />
                  {:else}
                    <div class="w-full h-48 bg-kitsuden-border flex items-center justify-center">
                      <Image class="w-12 h-12 text-kitsuden-subtle" />
                    </div>
                  {/if}
                  <div class="p-3">
                    <p class="text-kitsuden-text font-semibold text-sm line-clamp-1">
                      {seoOverrides.ogTitle ||
                        seoOverrides.metaTitle ||
                        title ||
                        tr("blogPostEditor.postTitle")}
                    </p>
                    <p class="text-kitsuden-subtle text-xs mt-1 line-clamp-2">
                      {seoOverrides.ogDescription ||
                        seoOverrides.metaDescription ||
                        excerpt ||
                        tr("blogPostEditor.noDescriptionProvided")}
                    </p>
                    <p class="text-kitsuden-subtle text-xs mt-2 uppercase tracking-wider">
                      {tr("blogPostEditor.yoursiteCom")}
                    </p>
                  </div>
                </div>
              </div>

              <!-- SEO Checklist -->
              <Card>
                <CardHeader>
                  <CardTitle level={3}>
                    {tr("blogPostEditor.seoChecklist")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div class="space-y-2">
                    {#each [{ label: tr("blogPostEditor.titleIsSet"), pass: title.length > 0 }, { label: tr("blogPostEditor.titleLengthOptimal3060"), pass: title.length >= 30 && title.length <= 60 }, { label: tr("blogPostEditor.slugIsSet"), pass: slug.length > 0 }, { label: tr("blogPostEditor.contentHas300Chars"), pass: content.length > 300 }, { label: tr("blogPostEditor.excerptIsSet"), pass: excerpt.length > 0 }, { label: tr("blogPostEditor.metaTitleOptimized"), pass: seoOverrides.metaTitle.length > 0 }, { label: tr("blogPostEditor.metaDescriptionOptimized"), pass: seoOverrides.metaDescription.length > 0 }, { label: tr("blogPostEditor.featuredImageSelected"), pass: !!featuredImageId }, { label: tr("blogPostEditor.hasAtLeastOneTag"), pass: tags.length > 0 }] as check}
                      <div class="flex items-center gap-2 text-xs">
                        {#if check.pass}
                          <CheckCircle2 class="w-3.5 h-3.5 text-kitsuden-green shrink-0" />
                          <span class="text-kitsuden-text-dim">{check.label}</span>
                        {:else}
                          <div
                            class="w-3.5 h-3.5 rounded-full border border-kitsuden-subtle/30 shrink-0"
                          ></div>
                          <span class="text-kitsuden-subtle">{check.label}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </CardContent></Card
              >
            </div>
          </div>
        </div>
      {/if}

      <!-- TAB: Settings -->
      {#if activeTab === "settings"}
        <div
          id="post-panel-settings"
          role="tabpanel"
          aria-labelledby="post-tab-settings"
          tabindex="-1"
          class="h-full overflow-y-auto p-6"
        >
          <div class="max-w-2xl mx-auto space-y-8">
            <div>
              <h2 class="text-lg font-semibold text-kitsuden-text mb-1">
                {tr("blogPostEditor.postSettings")}
              </h2>
              <p class="text-sm text-kitsuden-subtle">
                {tr("blogPostEditor.advancedConfigurationOptions")}
              </p>
            </div>

            <!-- Publishing Settings -->
            <Card>
              <CardHeader>
                <CardTitle level={3} class="flex items-center gap-2">
                  <Calendar class="w-4 h-4" />
                  {tr("blogPostEditor.publishingSchedule")}
                </CardTitle>
              </CardHeader>
              <CardContent class="space-y-6">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label for="status-2" class="mb-2 block">{tr("common.status")}</Label>
                    <Select id="status-2" bind:value={status}>
                      <option value="draft">{tr("blogPostEditor.draft")}</option>
                      <option value="scheduled">{tr("blogPostEditor.scheduled")}</option>
                      <option value="published">{tr("blogPostEditor.published")}</option>
                      <option value="archived">{tr("blogPostEditor.archived")}</option>
                    </Select>
                  </div>

                  <!--
                  ── THE SWITCH THAT WAS MISSING ─────────────────────────────

                  The column, the API and the block existed, and there was no way to
                  touch it from the panel: closing an article's thread could only be done
                  with a manual PATCH. In WordPress this is the «Discussion» box
                  of old.
                -->
                  <div>
                    <Checkbox bind:checked={commentsEnabled} class="text-xs!"
                      >{tr("blogPostEditor.allowComments")}</Checkbox
                    >
                    <p class="text-xs text-kitsuden-subtle mt-1">
                      {commentsEnabled
                        ? tr("blogPostEditor.readersCanCommentAnd")
                        : tr("blogPostEditor.closedThreadAlreadyWritten")}
                    </p>
                  </div>

                  {#if status === "scheduled"}
                    <div>
                      <Label for="publishedat-2" class="mb-2 flex! items-center gap-1">
                        <Clock class="w-3 h-3" />
                        {tr("blogPostEditor.publishAt")}
                      </Label>
                      <Input id="publishedat-2" type="datetime-local" bind:value={publishedAt} />
                    </div>
                  {/if}
                </div>
              </CardContent></Card
            >

            <!-- Author Settings -->
            <Card>
              <CardHeader>
                <CardTitle level={3} class="flex items-center gap-2">
                  <User class="w-4 h-4" />
                  {tr("common.author")}
                </CardTitle>
              </CardHeader>
              <CardContent class="space-y-4">
                <Select bind:value={authorId}>
                  <option value="">{tr("blogPostEditor.selectAuthor")}</option>
                  {#each availableAuthors as author}
                    <option value={author.id}
                      >{author.name}{author.email ? ` (${author.email})` : ""}</option
                    >
                  {/each}
                </Select>
              </CardContent></Card
            >

            <!--
              Community groups of THIS entry: they show up as two cards
              («Join the Facebook group» / «WhatsApp group») at the end of the
              article. Empty = the site's general group (Settings → Networks).
            -->
            <Card>
              <CardHeader>
                <CardTitle level={3} class="flex items-center gap-2">
                  <Users class="w-4 h-4" />
                  {tr("blogPostEditor.communityGroups")}
                </CardTitle>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label for="facebook-group" class="mb-2 block"
                      >{tr("blogPostEditor.facebookGroup")}</Label
                    >
                    <Input
                      id="facebook-group"
                      type="url"
                      bind:value={seoOverrides.facebookGroupUrl}
                      placeholder="https://www.facebook.com/groups/…"
                    />
                    {#if seoOverrides.facebookGroupUrl.trim() && !validFacebookLink(seoOverrides.facebookGroupUrl)}
                      <p class="text-xs text-kitsuden-accent-2 mt-1">
                        {tr("blogPostEditor.mustBeALink")}
                      </p>
                    {/if}
                  </div>
                  <div>
                    <Label for="whatsapp-group" class="mb-2 block"
                      >{tr("blogPostEditor.whatsappGroup")}</Label
                    >
                    <Input
                      id="whatsapp-group"
                      type="url"
                      bind:value={seoOverrides.whatsappGroupUrl}
                      placeholder="https://chat.whatsapp.com/…"
                    />
                    {#if seoOverrides.whatsappGroupUrl.trim() && !validWhatsappLink(seoOverrides.whatsappGroupUrl)}
                      <p class="text-xs text-kitsuden-accent-2 mt-1">
                        {tr("blogPostEditor.mustBeAnInvitation")}
                      </p>
                    {/if}
                  </div>
                </div>
                <p class="text-xs text-kitsuden-subtle">
                  {tr("blogPostEditor.emptyTheGeneralGroupOf")}
                </p>
              </CardContent></Card
            >

            <!-- Danger Zone -->
            {#if postId}
              <Card class="border-kitsuden-accent-2/30">
                <CardHeader>
                  <CardTitle level={3} class="text-kitsuden-accent-2 flex items-center gap-2">
                    <Trash2 class="w-4 h-4" />
                    {tr("blogPostEditor.dangerZone")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p class="text-sm text-kitsuden-subtle mb-4">
                    {tr("blogPostEditor.onceDeletedThisPostCannot")}
                  </p>
                  <Button variant="danger-ghost" onclick={handleDelete}>
                    <Trash2 class="w-4 h-4" />
                    {tr("blogPostEditor.deletePost")}
                  </Button>
                </CardContent></Card
              >
            {/if}
          </div>
        </div>
      {/if}
    {/snippet}
    {#if showPreview}
      <div class="flex-1 overflow-hidden">
        <SplitPane show={true}>
          {#snippet left()}
            <div class="h-full overflow-hidden">
              {@render editorPanels()}
            </div>
          {/snippet}
          {#snippet right()}
            <LivePreview {title} {content} {excerpt} {featuredImageUrl} {slug} {status} {blocks} />
          {/snippet}
        </SplitPane>
      </div>
    {:else}
      <div class="flex-1 overflow-hidden">
        {@render editorPanels()}
      </div>
    {/if}
  {/if}
</div>

<!--
  The picker lives in `MediaPicker`, not here.

  It used to be inside this file, and that is why the only admin screen from which
  an image could be chosen or uploaded was this one. Pulling it out is what gives
  the library to the page builder and to the dataset forms.
-->
<MediaPicker
  open={showMediaModal}
  title={imageTarget === "portada"
    ? tr("blogPostEditor.coverImage")
    : tr("blogPostEditor.insertImageInText")}
  selectedId={imageTarget === "portada" ? featuredImageId : null}
  onSelect={chooseImage}
  onClose={() => (showMediaModal = false)}
/>

<!-- Tag Selector Modal -->
<Dialog
  open={showTagModal}
  title={tr("blogPostEditor.manageTags")}
  onClose={() => (showTagModal = false)}
>
  <div class="space-y-4">
    <!-- New Tag Input -->
    <div class="flex gap-2">
      <Input
        class="flex-1"
        type="text"
        bind:value={newTagName}
        placeholder={tr("blogPostEditor.newTagName")}
        onkeydown={(e: KeyboardEvent) => e.key === "Enter" && createNewTag()}
      />
      <Button size="icon" onclick={createNewTag} ariaLabel={tr("common.create")}>
        <Plus class="w-4 h-4" />
      </Button>
    </div>

    <!-- Available Tags -->
    <div class="border-t border-kitsuden-border pt-4">
      <p class="text-xs text-kitsuden-subtle mb-3">{tr("blogPostEditor.clickToToggleTags")}</p>
      <div class="flex flex-wrap gap-2 max-h-64 overflow-y-auto">
        {#each availableTags as tag}
          <Toggle
            size="sm"
            class="rounded-full!"
            pressed={tags.some((t) => t.id === tag.id)}
            onchange={() => toggleTag(tag)}
          >
            {tag.name}
          </Toggle>
        {/each}
      </div>
    </div>
  </div>
</Dialog>

<!-- Promote From Dataset Modal -->
<PromoteFromDataset
  isOpen={showDatasetModal}
  onClose={() => (showDatasetModal = false)}
  onSelect={handleDatasetSelect}
/>

<Dialog
  open={showCategoryModal}
  title={tr("blogPostEditor.newCategory")}
  onClose={() => (showCategoryModal = false)}
>
  <div class="space-y-4">
    <div>
      <Label for="cat-name" class="mb-1.5 block">
        {tr("common.name")}
      </Label>
      <Input
        id="cat-name"
        type="text"
        bind:value={newCategory.name}
        placeholder={tr("blogPostEditor.guides")}
      />
      {#if newCategory.name.trim()}
        <p class="text-xs text-kitsuden-subtle mt-1">
          {tr("common.url")} <code>{generateSlug(newCategory.name)}</code>
        </p>
      {/if}
    </div>

    <div>
      <Label for="cat-parent" class="mb-1.5 block">
        {tr("blogPostEditor.insideOf")}
      </Label>
      <Select id="cat-parent" bind:value={newCategory.parentId}>
        <option value="">{tr("blogPostEditor.withoutParentCategory")}</option>
        {#each availableCategories as cat (cat.id)}
          <option value={cat.id}>{"— ".repeat(depthOf(cat))}{cat.name}</option>
        {/each}
      </Select>
    </div>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (showCategoryModal = false)}>
      {tr("common.cancel")}
    </Button>
    <Button
      onclick={async () => {
        await createCategory();
        showCategoryModal = false;
      }}
      disabled={!newCategory.name.trim()}
    >
      {tr("common.create")}
    </Button>
  {/snippet}
</Dialog>
