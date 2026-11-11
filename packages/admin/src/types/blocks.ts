import { t } from "$lib/i18n";
/**
 * Page Block System — Shared Types
 * Used by Admin (builder) and Web (renderer)
 */

// ─── Core Block Interface ─────────────────────────────────────
export interface PageBlock {
  id: string;
  type: BlockType;
  data: Record<string, any>;
  order: number;
}

export type BlockType =
  | "hero"
  | "richtext"
  | "image-gallery"
  | "game-map"
  | "tier-list"
  | "character-builder"
  | "comments"
  | "streamer-widget"
  | "embed"
  | "callout"
  | "facebook-group"
  | "divider"
  | "dynamic-carousel"
  | "smart-filter"
  | "comparison-slider"
  | "smart-grid"
  | "habitat-map"
  | "stat-compare"
  | "dex"
  | "affinity"
  | "event-search"
  | "race-planner"
  | "card-browser"
  | "deck-builder"
  | "deck-showcase"
  | "deck"
  | "set-searcher";

// ─── Block Data Shapes ────────────────────────────────────────
export interface HeroBlockData {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  ctaSecondaryLabel?: string;
  ctaSecondaryUrl?: string;
  overlay?: "dark" | "gradient" | "none";
}

export interface RichtextBlockData {
  content: string; // Markdown or HTML
  format: "markdown" | "html";
}

export interface ImageGalleryBlockData {
  images: Array<{
    url: string;
    alt?: string;
    caption?: string;
  }>;
  layout: "grid" | "masonry" | "carousel";
  columns?: number;
}

/**
 * Embedded tier list.
 *
 * REFERENCE only: the block points to a `kon-tierlist` template by its
 * slug and carries no data of its own. It is the lesson of the `game-map` block,
 * which was born with its markers inside and so every page ended up with a
 * diverging copy of the same map.
 *
 * A tier list is updated every patch. If it lived in the block, updating it
 * would mean editing every page where it appears — and some would be left stale.
 */
/**
 * Embedded comment thread.
 *
 * Like the tier list, REFERENCE only: it points to a `kon-comments` subject
 * by `(subjectType, subjectId)` and stores not a single comment.
 * A page's comments cannot live inside the block — they are
 * written after it is published.
 *
 * An empty `subjectId` means "this page's own", which is the normal case: the
 * article puts its own when rendering. Filling it in serves the rare case of
 * showing on a page the thread of something ELSE.
 */
/**
 * Embedded character builder.
 *
 * Like the tier list, REFERENCE only: it points to a `kon-character-builder`
 * definition by its slug. The definition —slots, formulas, catalogs— lives
 * there and is published once; the pages that embed it update themselves.
 *
 * It is an APPLICATION, not a document: the reader configures, the engine computes
 * stats and returns a shareable code. That is why the block is marked as
 * interactive and the site hydrates it, just like the map or the dynamic grid.
 */
export interface CharacterBuilderBlockData {
  /** Slug of a `kon-character-builder` definition. */
  definitionSlug: string;
  /** Lets the build be saved and shared by code. */
  allowSave?: boolean;
  /** Initial build, as a code. Empty = start from scratch. */
  initialCode?: string;
}

export interface CommentsBlockData {
  /** Subject type from the `@kitsuden/shared` vocabulary. */
  subjectType: string;
  /** Empty = the subject of the page where the block is. */
  subjectId?: string;
  /** "best" | "newest" | "oldest" (kon-comments' `order`). Up to 0.8: `orden`, "mejores"… */
  order?: "best" | "newest" | "oldest";
  /** Shows the reply form. Off = read-only thread. */
  allowReplies?: boolean;
}

export interface TierListBlockData {
  /** Slug of a `kon-tierlist` template. */
  templateSlug: string;
  /** Shows the pool of unranked elements under the rows. */
  showUnranked?: boolean;
  /**
   * Lets the reader build THEIR OWN from this one.
   *
   * It is what turns an editorial tier list into a TierMaker-style tool
   * without duplicating anything: the template is the same, the copy is the
   * reader's.
   */
  allowFork?: boolean;
  /** Text under the title: where the ranking comes from */
  note?: string;
  /** Id of another version to draw the diff ("what changed this patch"). */
  compareWith?: string;
}

/**
 * Interactive map. Two modes, and the order matters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `mapSlug` — REFERENCE to a `kon-maps` map. It is the recommended mode.
 *
 * The map lives in its table, with layers, validated categories, normalized
 * coordinates and thousands of markers importable in bulk. It is reused in
 * twenty pages and fixed in one place.
 *
 * `mapImageUrl` + `markers` — LOOSE mode, legacy. The markers live in
 * the block, pasted by hand as JSON. It serves for "a little map in a post" and
 * nothing more: it is not reused, not validated and fixing one coordinate requires
 * editing every page where it is.
 *
 * Both coexist because loose mode is already published in real content and
 * breaking it would mean rewriting posts. But a real game map goes in
 * `kon-maps` — otherwise every page has its own diverging copy.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface GameMapBlockData {
  /** Slug of a `kon-maps` map. If present, it takes precedence over everything else. */
  mapSlug?: string;
  /** Initial layer. Without it the map's first one is opened. */
  layerId?: string;
  /**
   * Cell size for grouping markers, in normalized coordinates.
   * `0` disables grouping. With thousands of markers it is what avoids an
   * unreadable blob at low zoom.
   */
  cluster?: number;

  /** @deprecated Loose mode: use `mapSlug` and a `kon-maps` map. */
  mapImageUrl?: string;
  mapTitle?: string;
  /** @deprecated The markers of a reusable map live in `kon-maps`. */
  markers?: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
    category?: string;
    description?: string;
    icon?: string;
  }>;
  /** @deprecated See `markers`. */
  categories?: Array<{
    name: string;
    color: string;
    icon: string;
  }>;
}

export interface StreamerWidgetBlockData {
  channelName: string;
  platform: "twitch" | "youtube" | "kick";
  showChat?: boolean;
  autoplay?: boolean;
}

export interface EmbedBlockData {
  url: string;
  caption?: string;
  aspectRatio?: "16:9" | "4:3" | "1:1";
}

export interface CalloutBlockData {
  title?: string;
  content: string;
  variant: "info" | "warning" | "success" | "danger" | "tip";
  icon?: string;
}

export interface FacebookGroupBlockData {
  /** Group link: https://facebook.com/groups/… */
  url: string;
  title?: string;
  description?: string;
  ctaLabel?: string;
}

export interface DividerBlockData {
  style: "line" | "gradient" | "dots" | "space";
}

export interface DynamicCarouselBlockData {
  source: "games" | "streamers";
  sortBy: "date" | "score" | "name";
  limit: number;
  autoplay: boolean;
}

export interface SmartFilterBlockData {
  enableGenreFilter: boolean;
  enablePlatformFilter: boolean;
  enableScoreSlider: boolean;
  targetDatasetId?: string;
}

export interface ComparisonSliderBlockData {
  beforeImageUrl: string;
  afterImageUrl: string;
  beforeLabel: string;
  afterLabel: string;
}

export interface SmartGridBlockData {
  datasetId: string;
  columns: string[]; // visible column keys (empty = show all)
  initialSort?: string; // field key to sort by default
  initialFilter?: Record<string, any>; // e.g. { type: "Sword" }
  enableGrouping: boolean;
  groupByField?: string; // field key to group by
}

/**
 * Where each row of a dataset lives, grouped by region.
 *
 * The "map" that can be published without coordinates: if the source says in which
 * region something appears but not exactly where, this shows it as is instead
 * of inventing markers.
 */
export interface HabitatMapBlockData {
  datasetId: string;
  /** Field with the list of regions of each row */
  groupField: string;
  nameField?: string;
  imageField?: string;
  /** Field with tags to filter by (elements, rarity…) */
  tagField?: string;
  filterField?: string;
  filterValue?: unknown;
  title?: string;
  note?: string;
}

/** Compare up to three rows of a dataset, stat by stat. */
export interface StatCompareBlockData {
  datasetId: string;
  stats: Array<{ key: string; label: string }>;
  nameField?: string;
  imageField?: string;
  tagField?: string;
  filterField?: string;
  filterValue?: unknown;
  max?: number;
  title?: string;
  note?: string;
}

/** A dataset read by the index: where it is and which field matches which. */
interface SheetDataset {
  datasetId: string;
  [field: string]: unknown;
}

/**
 * Index with cards ("Aniidex"): the rows of a dataset as a filterable index
 * at `/<game>/<segment>` and a card per row at `/<game>/<segment>/<row>`.
 *
 * The card is COMPOSED from other datasets (faceted with icon, skills,
 * trait, evolution line): none of that is copied into the row.
 */
export interface DexBlockData {
  datasetId: string;
  title: string;
  /** Address segment; `dex` by default */
  segment?: string;
  description?: string;
  /** Which field of the row is each thing: key (address), name, image, number… */
  fields: Record<string, string>;
  facets?: Array<{ field: string; label: string; datasetId?: string }>;
  stats?: Array<{ key: string; label: string }>;
  skills?: SheetDataset;
  trait?: SheetDataset;
  evolution?: SheetDataset;
  chips?: Array<{ field: string; label: string; tool?: string }>;
  news?: SheetDataset;
  note?: string;
}

/**
 * Affinity calculator: reads a dataset of characters and the field with their
 * kinship groups, and lets the reader build the tree (trained, two
 * parents and four grandparents) to add up the points they share.
 */
export interface AffinityBlockData {
  datasetId: string;
  title: string;
  description?: string;
  /** Row fields: key, name, image and the kinship groups one */
  fields: { key: string; name: string; image?: string; groups: string };
  /** What each piece of the tree is called in this game */
  labels?: { child?: string; parent?: string; grandparent?: string };
  note?: string;
}

/** Search over an events dataset: name, where it comes from and its options */
export interface SetSearcherBlockData {
  title?: string;
  description?: string;
  gameSlug: string;
}

export interface EventSearchBlockData {
  datasetId: string;
  title: string;
  description?: string;
  fields: { name: string; options: string; source?: string; card?: string; kind?: string };
  note?: string;
}

/** Calendar: a dataset whose rows occur in game turns (year, month, half) */
export interface RacePlannerBlockData {
  datasetId: string;
  title: string;
  description?: string;
  fields: {
    name: string;
    turns: string;
    degree?: string;
    surface?: string;
    distance?: string;
    hq?: string;
  };
  note?: string;
}

/**
 * The three card-game blocks carry no `datasetId`: their catalog does NOT
 * live in a CMS dataset but in `cardsim_cards`, and duplicating it would create two
 * truths about what a card is. What they store is the card game's SLUG,
 * which is the key kon-cardsim's showcase serves everything else by.
 */
export interface CardBrowserBlockData {
  /** Slug of the card game in kon-cardsim */
  cardGame: string;
  title: string;
  description?: string;
  /** Properties of `data` offered as a filter, in order */
  facets?: Array<{ field: string; label: string }>;
  note?: string;
}

export interface DeckBuilderBlockData {
  cardGame: string;
  title: string;
  description?: string;
  note?: string;
}

export interface DeckShowcaseBlockData {
  cardGame: string;
  title: string;
  description?: string;
  note?: string;
}

/**
 * A meta deck, embedded in an article.
 *
 * REFERENCE only, for the same reason as the tier list: it points to the archetype
 * (or to a specific list) by its id and does not copy a single card. A meta deck
 * changes every week; if the list lived inside the block, every article
 * would have its own copy aging separately.
 */
export interface DeckBlockData {
  /** Slug of the game, as it appears in its address */
  game: string;
  /** `archetype_id` of the archetype. Empty if a specific list is embedded. */
  archetype?: string;
  /** `deck_id` of a real list, to embed THAT one and not the archetype */
  deck?: string;
  /** What to show: the summary card or just the card list */
  view?: "summary" | "list";
  title?: string;
  note?: string;
}

// ─── Block Registry ───────────────────────────────────────────
export interface BlockDefinition {
  type: BlockType;
  label: string;
  icon: string;
  description: string;
  color: string;
  category: "content" | "media" | "interactive" | "layout";
  defaultData: Record<string, any>;
  fields: BlockFieldDef[];
}

export interface BlockFieldDef {
  key: string;
  label: string;
  /**
   * `gallery` is a LIST of images chosen from the library, with their alt and
   * caption. It exists because the gallery block asked for a `json` —a text
   * box in which to type the array by hand— with the library right next to it.
   */
  type:
    | "text"
    | "textarea"
    | "url"
    | "select"
    | "number"
    | "boolean"
    | "json"
    | "image"
    | "gallery"
    /**
     * A dropdown whose options are REQUESTED from the API.
     *
     * ── WHY A NEW TYPE WAS NEEDED ──────────────────────────────────────────
     *
     * `select` carries its options written in the registry, and that is fine when
     * they are two fixed values. But choosing "which tier list do I embed" is choosing
     * among DATA: the list lives in the database and changes every patch.
     *
     * Without this, the block asked for the slug in a free text field, with
     * `placeholder: "meta-5-4"`. Mistyping it gives no error: the page
     * is saved calmly and comes out without the tier list. It is the same family as
     * `post` versus `blog_post` in comments, and the one that produced
     * "Agregar All Gam": a hand-typed string instead of a chosen one.
     */
    | "remote-select";
  placeholder?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  /** Only for `remote-select`: where the options come from. */
  source?: {
    /** Path relative to the API, e.g. `/tierlist/templates`. */
    endpoint: string;
    /** Key of the array inside the response (`data`, `docs`…). */
    listKey: string;
    /** Field that is stored in the block. */
    valueKey: string;
    /** Field that is shown. */
    labelKey: string;
  };
  helpText?: string;
}

export const BLOCK_REGISTRY: BlockDefinition[] = [
  {
    type: "hero",
    label: t("blocks.heroSection"),
    icon: "Sparkles",
    description: t("blocks.fullWidthHeroWithTitle"),
    color: "#00E5FF",
    category: "content",
    defaultData: {
      title: "",
      subtitle: "",
      imageUrl: "",
      ctaLabel: "",
      ctaUrl: "",
      overlay: "gradient",
    } satisfies HeroBlockData as any,
    fields: [
      {
        key: "title",
        label: t("common.title"),
        type: "text",
        required: true,
        placeholder: t("blocks.heroHeadline"),
      },
      {
        key: "subtitle",
        label: t("blocks.subtitle"),
        type: "textarea",
        placeholder: t("blocks.supportingText"),
      },
      {
        key: "imageUrl",
        label: t("blocks.backgroundImage"),
        type: "url",
        placeholder: "https://...",
      },
      {
        key: "ctaLabel",
        label: t("blocks.ctaButtonText"),
        type: "text",
        placeholder: t("blocks.getStarted"),
      },
      { key: "ctaUrl", label: t("blocks.ctaButtonUrl"), type: "url", placeholder: "/games" },
      {
        key: "ctaSecondaryLabel",
        label: t("blocks.secondaryCtaText"),
        type: "text",
        placeholder: t("blocks.learnMore"),
      },
      { key: "ctaSecondaryUrl", label: t("blocks.secondaryCtaUrl"), type: "url" },
      {
        key: "overlay",
        label: t("blocks.overlayStyle"),
        type: "select",
        options: [
          { label: t("blocks.dark"), value: "dark" },
          { label: t("blocks.gradient"), value: "gradient" },
          { label: t("blocks.none"), value: "none" },
        ],
      },
    ],
  },
  {
    type: "richtext",
    label: t("blocks.richText"),
    icon: "FileText",
    description: t("blocks.formattedTextContentBlockWith"),
    color: "#E040FB",
    category: "content",
    defaultData: { content: "", format: "markdown" } satisfies RichtextBlockData as any,
    fields: [
      {
        key: "content",
        label: t("common.content"),
        type: "textarea",
        required: true,
        placeholder: t("blocks.writeInMarkdown"),
      },
      {
        key: "format",
        label: t("blocks.format"),
        type: "select",
        options: [
          { label: t("common.markdown"), value: "markdown" },
          { label: "HTML", value: "html" },
        ],
      },
    ],
  },
  {
    type: "image-gallery",
    label: t("blocks.imageGallery"),
    icon: "Images",
    description: t("blocks.gridMasonryOrCarouselOf"),
    color: "#FF6E40",
    category: "media",
    defaultData: { images: [], layout: "grid", columns: 3 } satisfies ImageGalleryBlockData as any,
    fields: [
      {
        key: "images",
        label: t("blocks.images"),
        type: "gallery",
        required: true,
        helpText: '[{"url":"...","alt":"...","caption":"..."}]',
      },
      {
        key: "layout",
        label: t("blocks.layout"),
        type: "select",
        options: [
          { label: t("blocks.grid"), value: "grid" },
          { label: t("blocks.masonry"), value: "masonry" },
          { label: t("blocks.carousel"), value: "carousel" },
        ],
      },
      { key: "columns", label: t("blocks.columns"), type: "number" },
    ],
  },
  {
    type: "character-builder",
    label: t("blocks.characterBuilder"),
    icon: "Hammer",
    description: t("blocks.characterBuilderKonBuilder"),
    color: "#26A69A",
    category: "interactive",
    defaultData: {
      definitionSlug: "",
      allowSave: true,
      initialCode: "",
    } satisfies CharacterBuilderBlockData as any,
    fields: [
      {
        key: "definitionSlug",
        label: t("blocks.builder"),
        type: "remote-select",
        required: true,
        source: {
          endpoint: "/builder/definitions",
          listKey: "data",
          valueKey: "slug",
          labelKey: "name",
        },
        helpText: t("blocks.publishedDefinitionsHelp"),
      },
      {
        key: "allowSave",
        label: t("blocks.allowSaveAndShare"),
        type: "boolean",
        helpText: t("blocks.addsSaveButton"),
      },
      {
        key: "initialCode",
        label: t("blocks.initialCodeBuild"),
        type: "text",
        placeholder: "",
        helpText: t("blocks.startsWithExistingBuild"),
      },
    ],
  },
  {
    type: "comments",
    label: t("blocks.comments"),
    icon: "MessageSquare",
    description: t("blocks.konCommentsThreadOn"),
    color: "#7E57C2",
    category: "interactive",
    defaultData: {
      subjectType: "blog_post",
      subjectId: "",
      order: "best",
      allowReplies: true,
    } satisfies CommentsBlockData as any,
    fields: [
      {
        key: "subjectType",
        label: t("blocks.subjectType"),
        type: "select",
        required: true,
        options: [
          { label: t("blocks.blogArticle"), value: "blog_post" },
          { label: t("blocks.builderPage"), value: "block_page" },
          { label: t("blocks.wikiPage"), value: "wiki_page" },
        ],
        helpText: t("blocks.subjectVocabularyHelp"),
      },
      {
        key: "subjectId",
        label: t("blocks.optionalSubjectId"),
        type: "text",
        placeholder: "",
        helpText: t("blocks.emptyTheOneOfThisPage"),
      },
      {
        key: "order",
        label: t("blocks.order"),
        type: "select",
        options: [
          { label: t("blocks.best"), value: "best" },
          { label: t("blocks.newest"), value: "newest" },
          { label: t("blocks.oldest"), value: "oldest" },
        ],
      },
      {
        key: "allowReplies",
        label: t("blocks.allowReply"),
        type: "boolean",
        helpText: t("blocks.offLeavesThreadIn"),
      },
    ],
  },
  {
    type: "tier-list",
    label: t("blocks.tierList"),
    icon: "ListOrdered",
    description: t("blocks.tierlistKonTierList"),
    color: "#FFB300",
    category: "interactive",
    defaultData: {
      templateSlug: "",
      showUnranked: true,
      allowFork: false,
    } satisfies TierListBlockData as any,
    fields: [
      {
        key: "templateSlug",
        label: t("blocks.tierList2"),
        type: "remote-select",
        required: true,
        source: {
          endpoint: "/tierlist/templates",
          listKey: "data",
          valueKey: "slug",
          labelKey: "title",
        },
        helpText: t("blocks.tierListTemplateHelp"),
      },
      {
        key: "showUnranked",
        label: t("blocks.showUnranked"),
        type: "boolean",
        helpText: t("blocks.thePoolOfWhat"),
      },
      {
        key: "allowFork",
        label: t("blocks.allowReaderToDo"),
        type: "boolean",
        helpText: t("blocks.addsForkButton"),
      },
      {
        key: "note",
        label: t("blocks.note"),
        type: "text",
        helpText: t("blocks.underTitleOfWhere"),
      },
      {
        key: "compareWith",
        label: t("blocks.compareWithVersionId"),
        type: "text",
        placeholder: "",
        helpText: t("blocks.paintsDiffWhoUploaded"),
      },
    ],
  },
  {
    type: "game-map",
    label: t("blocks.gameMap"),
    icon: "Map",
    description: t("blocks.interactiveMapReferencesAMap"),
    color: "#76FF03",
    category: "interactive",
    // The default points to REFERENCE mode: a new block must be born
    // pointing to a reusable map, not with its own copy of markers.
    defaultData: {
      mapSlug: "",
      layerId: "",
      cluster: 0,
    } satisfies GameMapBlockData as any,
    fields: [
      {
        key: "mapSlug",
        label: t("blocks.konMapsSlugMap"),
        type: "text",
        placeholder: "acto-1",
        helpText: t("blocks.recommendedMapHelp"),
      },
      {
        key: "layerId",
        label: t("blocks.initialLayer"),
        type: "text",
        placeholder: "surface",
        helpText: t("blocks.emptyTheFirstLayerOf"),
      },
      {
        key: "cluster",
        label: t("blocks.groupMarkers"),
        type: "number",
        helpText: t("blocks.cellSizeHelp"),
      },
      {
        key: "mapImageUrl",
        label: t("blocks.mapImageLooseMode"),
        type: "url",
        placeholder: "https://...",
        helpText: t("blocks.inheritedOnlyIfYouDontUse"),
      },
      {
        key: "mapTitle",
        label: t("blocks.mapTitle"),
        type: "text",
        placeholder: t("blocks.worldMap"),
      },
      {
        key: "markers",
        label: t("blocks.markersJson"),
        type: "json",
        helpText: '[{"id":"1","label":"Town","x":50,"y":30}]',
      },
      {
        key: "categories",
        label: t("blocks.categoriesJson"),
        type: "json",
        helpText: '[{"name":"Towns","color":"#00E5FF","icon":"🏘️"}]',
      },
    ],
  },
  {
    type: "streamer-widget",
    label: t("blocks.streamerWidget"),
    icon: "Tv",
    description: t("blocks.liveStreamEmbedWithChat"),
    color: "#FF2A6D",
    category: "interactive",
    defaultData: {
      channelName: "",
      platform: "twitch",
      showChat: false,
      autoplay: false,
    } satisfies StreamerWidgetBlockData as any,
    fields: [
      {
        key: "channelName",
        label: t("blocks.channelName"),
        type: "text",
        required: true,
        placeholder: "ninja",
      },
      {
        key: "platform",
        label: t("common.platform"),
        type: "select",
        options: [
          { label: t("blocks.twitch"), value: "twitch" },
          { label: t("blocks.youtube"), value: "youtube" },
          { label: t("blocks.kick"), value: "kick" },
        ],
      },
      { key: "showChat", label: t("blocks.showChat"), type: "boolean" },
      { key: "autoplay", label: t("blocks.autoplay"), type: "boolean" },
    ],
  },
  {
    type: "embed",
    /**
     * ── WHY IT IS CALLED "VIDEO" AND NOT "EMBED" ───────────────────────────
     *
     * Nobody searches for "Embed" when what they want is to put in a YouTube video.
     * The technical name describes the mechanism, not the intent, and in a list
     * of thirteen blocks that is the difference between finding it and not finding it.
     *
     * The internal type is still `embed`: changing it would break the blocks already
     * saved. What changes is how it is presented.
     */
    label: t("blocks.videoOrEmbedded"),
    icon: "Code2",
    description: t("blocks.pasteTheYoutubeLink"),
    color: "#40C4FF",
    category: "media",
    defaultData: { url: "", caption: "", aspectRatio: "16:9" } satisfies EmbedBlockData as any,
    fields: [
      {
        key: "url",
        label: t("blocks.videoLink"),
        type: "url",
        required: true,
        placeholder: "https://www.youtube.com/watch?v=...",
        /**
         * The placeholder STILL is the URL from the browser bar,
         * and now that is true: before it promised something that produced
         * a blank frame, because YouTube does not allow embedding `/watch`
         * (`X-Frame-Options: SAMEORIGIN`). The conversion is done by the
         * renderer, so pasting what you copy works.
         */
        helpText: t("blocks.videoLinkHelp"),
      },
      { key: "caption", label: t("blocks.pie"), type: "text" },
      {
        key: "aspectRatio",
        label: t("blocks.aspectRatio"),
        type: "select",
        options: [
          { label: "16:9", value: "16:9" },
          { label: "4:3", value: "4:3" },
          { label: "1:1", value: "1:1" },
        ],
      },
    ],
  },
  {
    type: "callout",
    label: t("blocks.calloutBox"),
    icon: "AlertTriangle",
    description: t("blocks.highlightedInfoWarningOrTip"),
    color: "#FFD600",
    category: "content",
    defaultData: { title: "", content: "", variant: "info" } satisfies CalloutBlockData as any,
    fields: [
      { key: "title", label: t("common.title"), type: "text", placeholder: t("blocks.note") },
      { key: "content", label: t("common.content"), type: "textarea", required: true },
      {
        key: "variant",
        label: t("blocks.variant"),
        type: "select",
        options: [
          { label: t("blocks.info"), value: "info" },
          { label: t("blocks.warning"), value: "warning" },
          { label: t("blocks.success"), value: "success" },
          { label: t("blocks.danger"), value: "danger" },
          { label: t("blocks.tip"), value: "tip" },
        ],
      },
    ],
  },
  {
    type: "facebook-group",
    label: t("blocks.facebookGroup"),
    icon: "Users",
    description: t("blocks.cardInvitingToJoin"),
    color: "#1877F2",
    category: "content",
    defaultData: {
      url: "",
      title: "",
      description: "",
      ctaLabel: "",
    } satisfies FacebookGroupBlockData as any,
    fields: [
      {
        key: "url",
        label: t("blocks.groupLink"),
        type: "text",
        required: true,
        placeholder: "https://facebook.com/groups/…",
      },
      {
        key: "title",
        label: t("blocks.optionalTitle"),
        type: "text",
        placeholder: t("blocks.joinOurGroupOf"),
      },
      { key: "description", label: t("blocks.optionalText"), type: "textarea" },
      {
        key: "ctaLabel",
        label: t("blocks.optionalButtonText"),
        type: "text",
        placeholder: t("blocks.joinTheGroup"),
      },
    ],
  },
  {
    type: "divider",
    label: t("blocks.divider"),
    icon: "Minus",
    description: t("blocks.visualSeparatorBetweenContentSections"),
    color: "#9E9E9E",
    category: "layout",
    defaultData: { style: "gradient" } satisfies DividerBlockData as any,
    fields: [
      {
        key: "style",
        label: t("blocks.style"),
        type: "select",
        options: [
          { label: t("blocks.line"), value: "line" },
          { label: t("blocks.gradient"), value: "gradient" },
          { label: t("blocks.dots"), value: "dots" },
          { label: t("blocks.space"), value: "space" },
        ],
      },
    ],
  },
  // ── Smart Blocks ──
  {
    type: "dynamic-carousel",
    label: t("blocks.dynamicCarousel"),
    icon: "Clapperboard",
    description: t("blocks.autoPopulatedCarouselOfGames"),
    color: "#FF6E40",
    category: "interactive",
    defaultData: {
      source: "games",
      sortBy: "date",
      limit: 8,
      autoplay: false,
    } satisfies DynamicCarouselBlockData as any,
    fields: [
      {
        key: "source",
        label: t("blocks.dataSource"),
        type: "select",
        required: true,
        options: [
          { label: t("common.games"), value: "games" },
          { label: t("common.streamers"), value: "streamers" },
        ],
      },
      {
        key: "sortBy",
        label: t("blocks.sortBy"),
        type: "select",
        options: [
          { label: t("blocks.releaseDate"), value: "date" },
          { label: t("common.score"), value: "score" },
          { label: t("common.name"), value: "name" },
        ],
      },
      { key: "limit", label: t("blocks.maxItems"), type: "number" },
      { key: "autoplay", label: t("blocks.autoplay"), type: "boolean" },
    ],
  },
  {
    type: "smart-filter",
    label: t("blocks.smartFilter"),
    icon: "SlidersHorizontal",
    description: t("blocks.dynamicGenrePlatformAndScore"),
    color: "#69F0AE",
    category: "interactive",
    defaultData: {
      enableGenreFilter: true,
      enablePlatformFilter: true,
      enableScoreSlider: false,
    } satisfies SmartFilterBlockData as any,
    fields: [
      { key: "enableGenreFilter", label: t("blocks.enableGenreFilter"), type: "boolean" },
      { key: "enablePlatformFilter", label: t("blocks.enablePlatformFilter"), type: "boolean" },
      { key: "enableScoreSlider", label: t("blocks.enableScoreSlider"), type: "boolean" },
      {
        key: "targetDatasetId",
        label: t("blocks.targetDatasetIdOptional"),
        type: "text",
        helpText: t("blocks.leaveEmptyToFilterGames"),
      },
    ],
  },
  {
    type: "comparison-slider",
    label: t("blocks.comparisonSlider"),
    icon: "Columns",
    description: t("blocks.beforeAfterImageComparisonWith"),
    color: "#B388FF",
    category: "media",
    defaultData: {
      beforeImageUrl: "",
      afterImageUrl: "",
      beforeLabel: "Before",
      afterLabel: "After",
    } satisfies ComparisonSliderBlockData as any,
    fields: [
      {
        key: "beforeImageUrl",
        label: t("blocks.beforeImage"),
        type: "image",
        required: true,
        placeholder: "https://...",
      },
      {
        key: "afterImageUrl",
        label: t("blocks.afterImage"),
        type: "image",
        required: true,
        placeholder: "https://...",
      },
      {
        key: "beforeLabel",
        label: t("blocks.beforeLabel"),
        type: "text",
        placeholder: t("blocks.before"),
      },
      {
        key: "afterLabel",
        label: t("blocks.afterLabel"),
        type: "text",
        placeholder: t("blocks.after"),
      },
    ],
  },
  {
    type: "smart-grid",
    label: t("blocks.smartDataGrid"),
    icon: "Table2",
    description: t("blocks.airtableStyleDataGridWith"),
    color: "#00BFA5",
    category: "interactive",
    defaultData: {
      datasetId: "",
      columns: [],
      initialSort: "",
      initialFilter: {},
      enableGrouping: false,
      groupByField: "",
    } satisfies SmartGridBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.datasetId"),
        type: "text",
        required: true,
        placeholder: t("blocks.pasteDatasetUuid"),
      },
      {
        key: "columns",
        label: t("blocks.visibleColumnsJson"),
        type: "json",
        helpText: t("blocks.nameDamageRarityEmptyArray"),
      },
      {
        key: "initialSort",
        label: t("blocks.defaultSortField"),
        type: "text",
        placeholder: t("blocks.eGName"),
      },
      {
        key: "initialFilter",
        label: t("blocks.initialFilterJson"),
        type: "json",
        helpText: '{"rarity": "Legendary"}',
      },
      { key: "enableGrouping", label: t("blocks.enableGrouping"), type: "boolean" },
      {
        key: "groupByField",
        label: t("blocks.groupByField"),
        type: "text",
        placeholder: t("blocks.eGRarity"),
      },
    ],
  },
  {
    type: "habitat-map",
    label: t("blocks.habitatMap"),
    icon: "MapPin",
    description: t("blocks.whatIsInEachRegion"),
    color: "#26A69A",
    category: "interactive",
    defaultData: {
      datasetId: "",
      groupField: "habitats",
      nameField: "name",
      imageField: "image",
      tagField: "",
      title: "",
      note: "",
    } satisfies HabitatMapBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.dataset"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/data-sets", listKey: "docs", valueKey: "id", labelKey: "name" },
      },
      {
        key: "groupField",
        label: t("blocks.regionsField"),
        type: "text",
        required: true,
        placeholder: "habitats",
      },
      { key: "nameField", label: t("blocks.nameField"), type: "text", placeholder: "name" },
      { key: "imageField", label: t("blocks.imageField"), type: "text", placeholder: "image" },
      { key: "tagField", label: t("blocks.fieldToFilter"), type: "text", placeholder: "elements" },
      {
        key: "filterField",
        label: t("blocks.onlyRowsWithField"),
        type: "text",
        placeholder: "in_index",
      },
      {
        key: "filterValue",
        label: t("blocks.equalToJson"),
        type: "json",
        helpText: t("blocks.trueBasicForm"),
      },
      { key: "title", label: t("blocks.title"), type: "text" },
      {
        key: "note",
        label: t("blocks.note"),
        type: "text",
        helpText: t("blocks.whereTheDataComesFrom"),
      },
    ],
  },
  {
    type: "stat-compare",
    label: t("blocks.statCompare"),
    icon: "Scale",
    description: t("blocks.comparesUpToThreeRowsOf"),
    color: "#7E57C2",
    category: "interactive",
    defaultData: {
      datasetId: "",
      stats: [],
      nameField: "name",
      imageField: "image",
      max: 3,
      title: "",
      note: "",
    } satisfies StatCompareBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.dataset"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/data-sets", listKey: "docs", valueKey: "id", labelKey: "name" },
      },
      {
        key: "stats",
        label: t("blocks.statsJson"),
        type: "json",
        required: true,
        helpText: t("blocks.datasetNumericFields"),
      },
      { key: "nameField", label: t("blocks.nameField"), type: "text", placeholder: "name" },
      { key: "imageField", label: t("blocks.imageField"), type: "text", placeholder: "image" },
      { key: "tagField", label: t("blocks.tagsField"), type: "text", placeholder: "elements" },
      { key: "filterField", label: t("blocks.onlyRowsWithField"), type: "text" },
      { key: "filterValue", label: t("blocks.equalToJson"), type: "json" },
      { key: "title", label: t("blocks.title"), type: "text" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "event-search",
    label: t("blocks.eventSearcher"),
    icon: "Search",
    description: t("blocks.searchesInDatasetOf"),
    color: "#A3E635",
    category: "interactive",
    defaultData: {
      datasetId: "",
      title: "",
      fields: { name: "name", options: "options", source: "character", kind: "kind" },
      note: "",
    } satisfies EventSearchBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.eventsDataset"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/data-sets", listKey: "docs", valueKey: "id", labelKey: "name" },
      },
      { key: "title", label: t("blocks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea" },
      { key: "fields", label: t("blocks.jsonFields"), type: "json" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "race-planner",
    label: t("blocks.raceCalendar"),
    icon: "CalendarRange",
    description: t("blocks.theRowsOfADataset"),
    color: "#38BDF8",
    category: "interactive",
    defaultData: {
      datasetId: "",
      title: "",
      fields: {
        name: "name",
        turns: "turns",
        degree: "grade",
        surface: "surface",
        distance: "distance",
        hq: "venue",
      },
      note: "",
    } satisfies RacePlannerBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.racesDataset"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/data-sets", listKey: "docs", valueKey: "id", labelKey: "name" },
      },
      { key: "title", label: t("blocks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea" },
      { key: "fields", label: t("blocks.jsonFields"), type: "json" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "card-browser",
    label: t("blocks.cardCatalog"),
    icon: "LayoutGrid",
    description: t("blocks.theCardsOfAGame"),
    color: "#F59E0B",
    category: "interactive",
    defaultData: {
      cardGame: "",
      title: "Cards",
      facets: [],
    } satisfies CardBrowserBlockData as any,
    fields: [
      {
        key: "cardGame",
        label: t("blocks.cardGame"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/cardsim/games", listKey: "data", valueKey: "slug", labelKey: "name" },
      },
      { key: "title", label: t("blocks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea" },
      { key: "facets", label: t("blocks.facetsJson"), type: "json" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "deck-builder",
    label: t("blocks.deckBuilder"),
    icon: "Layers",
    description: t("blocks.buildsADeckAgainstThe"),
    color: "#F59E0B",
    category: "interactive",
    defaultData: {
      cardGame: "",
      title: "Deck builder",
    } satisfies DeckBuilderBlockData as any,
    fields: [
      {
        key: "cardGame",
        label: t("blocks.cardGame"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/cardsim/games", listKey: "data", valueKey: "slug", labelKey: "name" },
      },
      { key: "title", label: t("blocks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "deck-showcase",
    label: t("blocks.deckShowcase"),
    icon: "Trophy",
    description: t("blocks.publishedDecksOfA"),
    color: "#F59E0B",
    category: "interactive",
    defaultData: {
      cardGame: "",
      title: "Community decks",
    } satisfies DeckShowcaseBlockData as any,
    fields: [
      {
        key: "cardGame",
        label: t("blocks.cardGame"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/cardsim/games", listKey: "data", valueKey: "slug", labelKey: "name" },
      },
      { key: "title", label: t("blocks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "deck",
    label: t("blocks.metaDeck"),
    icon: "Layers",
    description: t("blocks.anArchetypeOfTheMetaOr"),
    color: "#F59E0B",
    category: "interactive",
    defaultData: {
      game: "",
      archetype: "",
      view: "summary",
    } satisfies DeckBlockData as any,
    fields: [
      {
        key: "game",
        label: t("blocks.game"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/games", listKey: "docs", valueKey: "slug", labelKey: "title" },
      },
      {
        key: "archetype",
        label: t("blocks.archetype"),
        type: "text",
        helpText: t("blocks.theArchetypeIdThe"),
      },
      {
        key: "deck",
        label: t("blocks.optionalConcreteList"),
        type: "text",
        helpText: t("blocks.theIdOfAList"),
      },
      {
        key: "view",
        label: t("blocks.whatToTeach"),
        type: "select",
        options: [
          { value: "summary", label: t("blocks.summaryCardFiguresAndCards") },
          { value: "list", label: t("blocks.onlyCardList") },
        ],
      },
      { key: "title", label: t("blocks.title"), type: "text" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "affinity",
    label: t("blocks.affinityCalculator"),
    icon: "GitMerge",
    description: t("blocks.trainedInheritanceTreeParents"),
    color: "#22D3EE",
    category: "interactive",
    defaultData: {
      datasetId: "",
      title: "",
      fields: { key: "slug", name: "name", image: "image", groups: "relations" },
      note: "",
    } satisfies AffinityBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.charactersDataset"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/data-sets", listKey: "docs", valueKey: "id", labelKey: "name" },
      },
      { key: "title", label: t("blocks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea" },
      { key: "fields", label: t("blocks.jsonFields"), type: "json" },
      { key: "labels", label: t("blocks.jsonTreeNames"), type: "json" },
      { key: "note", label: t("blocks.note"), type: "text" },
    ],
  },
  {
    type: "dex",
    label: t("blocks.cardIndex"),
    icon: "Library",
    description: t("blocks.filterableDatasetIndex"),
    color: "#EF5350",
    category: "interactive",
    defaultData: {
      datasetId: "",
      title: "",
      segment: "",
      fields: { key: "slug", name: "name", image: "image", number: "", total: "" },
      facets: [],
      stats: [],
      note: "",
    } satisfies DexBlockData as any,
    fields: [
      {
        key: "datasetId",
        label: t("blocks.dataset"),
        type: "remote-select",
        required: true,
        source: { endpoint: "/data-sets", listKey: "docs", valueKey: "id", labelKey: "name" },
      },
      {
        key: "title",
        label: t("blocks.title"),
        type: "text",
        required: true,
        placeholder: t("blocks.aniidex"),
      },
      {
        key: "segment",
        label: t("blocks.address"),
        type: "text",
        placeholder: "aniidex",
        helpText: "/<game>/<segment>. Letters, numbers and hyphens.",
      },
      { key: "description", label: t("common.description"), type: "text" },
      {
        key: "fields",
        label: t("blocks.jsonFields"),
        type: "json",
        required: true,
        helpText:
          '{"key": "slug", "name": "name", "image": "image", "number": "entry", "total": "total"}',
      },
      {
        key: "facets",
        label: t("blocks.filtersJson"),
        type: "json",
        helpText: t("blocks.text6"),
      },
      {
        key: "stats",
        label: t("blocks.statsJson"),
        type: "json",
        helpText: '[{"key": "hp", "label": "Health"}]',
      },
      {
        key: "skills",
        label: t("blocks.skillsJson"),
        type: "json",
        helpText: t("blocks.datasetKeyAndGroupsOf"),
      },
      { key: "trait", label: t("blocks.traitJson"), type: "json" },
      { key: "evolution", label: t("blocks.evolutionLineJson"), type: "json" },
      {
        key: "chips",
        label: t("blocks.listsJson"),
        type: "json",
        helpText: t("blocks.text8"),
      },
      { key: "news", label: t("blocks.newsJson"), type: "json" },
      {
        key: "note",
        label: t("blocks.note"),
        type: "text",
        helpText: t("blocks.whereDataComesFrom"),
      },
    ],
  },
];

// ─── Utility ──────────────────────────────────────────────────
export function createBlock(type: BlockType, order: number): PageBlock {
  const def = BLOCK_REGISTRY.find((b) => b.type === type);
  return {
    id: `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    data: structuredClone(def?.defaultData || {}),
    order,
  };
}

export function getBlockDef(type: BlockType): BlockDefinition | undefined {
  return BLOCK_REGISTRY.find((b) => b.type === type);
}
