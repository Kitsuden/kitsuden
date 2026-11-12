<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import { page } from "$app/stores";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { toast } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import {
    Key,
    Plus,
    Trash2,
    Copy,
    CheckCircle2,
    ShieldAlert,
    Palette,
    Cpu,
    Bot,
    Check,
    Database,
    Server,
    Link2,
    Globe,
    TestTube,
    LibraryBig,
    Users,
    ShieldCheck,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  import MediaPicker from "$lib/components/media/MediaPicker.svelte";
  import SecretsPanel from "$lib/components/settings/SecretsPanel.svelte";
  import TwoFactorPanel from "$lib/components/settings/TwoFactorPanel.svelte";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import UnsavedGuard from "$lib/components/feedback/UnsavedGuard.svelte";
  import { queryChoice, setQuery } from "$lib/page";
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CodeBlock,
    Dialog,
    EmptyState,
    Field,
    Input,
    Label,
    NumberInput,
    SaveBar,
    Select,
    Spinner,
    Stat,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    Textarea,
    type TabItem,
  } from "$lib/tallao";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  /**
   * The tab IS the `?tab=` of the address: choosing one navigates (a history entry), so
   * back/forward walk the tabs and a copied link opens the same one. It used to be read
   * once on mount and never written back.
   */
  const TAB_IDS = [
    "general",
    "appearance",
    "security",
    "keys",
    "secrets",
    "agents",
    "mcp",
    "datasources",
    "system",
  ] as const;
  const activeTab = $derived<string>(queryChoice($page.url, "tab", TAB_IDS, "general"));
  function selectTab(tab: string) {
    void setQuery($page.url, { tab: tab === "general" ? null : tab });
  }

  const SETTINGS_TABS: TabItem[] = [
    { id: "general", label: t("settings.general") },
    { id: "appearance", label: t("settings.appearance") },
    { id: "security", label: t("twoFactor.security") },
    { id: "keys", label: t("settings.apiKeys") },
    { id: "secrets", label: t("settings.secrets") },
    { id: "agents", label: t("settings.agents") },
    { id: "mcp", label: t("settings.mcp") },
    { id: "datasources", label: t("settings.dataSources") },
    { id: "system", label: t("settings.system") },
  ];
  const TAB_ICONS: Record<string, typeof Palette | undefined> = {
    appearance: Palette,
    security: ShieldCheck,
    keys: Key,
    secrets: ShieldAlert,
    agents: Bot,
    mcp: Cpu,
    datasources: Database,
    system: ShieldAlert,
  };

  // ── System tab ───────────────────────────────────────────────────────────
  //
  // The data is requested when the tab is OPENED, not when the screen is mounted: they are two
  // admin queries and most visits to Settings do not get
  // here. `loadedSystem` avoids repeating them when going back and forth between tabs.
  interface SystemUser {
    id: string;
    email: string;
    name: string | null;
    role: string;
    createdAt: string | null;
  }
  interface SystemStatus {
    migrations: { total: number; latest: { name: string; baselined: boolean }[] };
    kons: { total: number; active: number };
    installed: unknown[];
  }

  let users = $state<SystemUser[]>([]);
  let status = $state<SystemStatus | null>(null);
  let loadingSystem = $state(false);
  let systemError = $state<string | null>(null);
  let loadedSystem = false;

  $effect(() => {
    if (activeTab !== "system" || loadedSystem) return;
    loadedSystem = true;
    void loadSystem();
  });

  async function loadSystem() {
    loadingSystem = true;
    systemError = null;
    try {
      const [ru, re_] = await Promise.all([
        fetch(`${API_URL}/api/admin/system/users`, { credentials: "include" }),
        fetch(`${API_URL}/api/admin/system/status`, { credentials: "include" }),
      ]);

      // A 403 here is not a failure: it means whoever is looking is not an admin. It is
      // said as it is instead of leaving the screen empty, which is how
      // all the screens fixed recently were.
      if (ru.status === 403 || re_.status === 403) {
        systemError = t("settings.thisSectionRequiresAdminRole");
        return;
      }
      if (!ru.ok || !re_.ok) throw new Error(`HTTP ${ru.status}/${re_.status}`);

      users = (await ru.json()).data ?? [];
      status = await re_.json();
    } catch (err) {
      systemError = t("settings.couldNotLoad", { err: err instanceof Error ? err.message : err });
      loadedSystem = false; // allow a retry on re-entering
    } finally {
      loadingSystem = false;
    }
  }

  async function changeRole(id: string, role: string) {
    try {
      const res = await fetch(`${API_URL}/api/admin/system/users/${id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // The API refuses to leave the installation without administrators and to let
        // someone demote themselves. The reason travels in `message`; without
        // showing it, the select would snap back with no explanation.
        toast.error([body.error, body.message].filter(Boolean).join("\n\n"));
        await loadSystem();
        return;
      }

      users = users.map((u) => (u.id === id ? { ...u, role } : u));
    } catch (err) {
      toast.error(
        t("settings.couldNotChangeThe", { err: err instanceof Error ? err.message : err })
      );
    }
  }

  onMount(() => {
    loadSettings();
  });

  // ============ API Keys Tab State ============
  let keys = $state<any[]>([]);
  let loadingKeys = $state(true);
  let errorKeys = $state<string | null>(null);

  // ============ Agents Tab State ============
  interface Agent {
    id: string;
    name: string;
    description?: string;
    scopes: string[];
    rateLimit: number;
    isActive: boolean;
    createdAt: string;
    keys: AgentKey[];
  }
  interface AgentKey {
    id: string;
    keyPrefix: string;
    createdAt: string;
    lastUsedAt?: string;
    expiresAt?: string;
  }
  interface AuditLog {
    id: string;
    action: string;
    resource?: string;
    success: boolean;
    ipAddress?: string;
    createdAt: string;
    errorMessage?: string;
  }

  let agents = $state<Agent[]>([]);
  let loadingAgents = $state(true);
  let errorAgents = $state("");
  let selectedAgent = $state<Agent | null>(null);

  // Agents Modals
  let showCreateAgentModal = $state(false);
  let showAgentDetailModal = $state(false);
  let showNewAgentKeyModal = $state(false);
  let newAgentApiKey = $state("");
  let agentKeyCopied = $state(false);

  // Agents Tabs
  let agentDetailTab = $state<"details" | "logs" | "stats">("details");
  // The labels were already literal English here; they keep their text.
  const AGENT_DETAIL_TABS: TabItem[] = [
    { id: "details", label: "Details" },
    { id: "logs", label: "Audit Logs" },
    { id: "stats", label: "Statistics" },
  ];
  let auditLogs = $state<AuditLog[]>([]);
  let agentStats = $state<any>(null);

  // Agents Form
  let agentFormName = $state("");
  let agentFormDescription = $state("");
  let agentFormScopes = $state("mcp:connect,read:datasets");
  let agentFormRateLimit = $state<number | null>(60);
  let agentFormExpiresInDays = $state<number | null>(null);

  // ============ Data Sources Tab State ============
  interface DataSource {
    id: string;
    name: string;
    type: "postgresql" | "mysql" | "mongodb" | "redis" | "api" | "webhook";
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    url?: string;
    headers?: Record<string, string>;
    isActive: boolean;
    lastSyncAt?: string;
    createdAt: string;
  }

  let dataSources = $state<DataSource[]>([]);
  let loadingDataSources = $state(true);
  let errorDataSources = $state("");
  let showCreateDataSourceModal = $state(false);
  let testingConnection = $state(false);
  let testResult = $state<{ success: boolean; message: string } | null>(null);

  // Data Source Form
  let dataSourceForm = $state({
    name: "",
    type: "postgresql" as DataSource["type"],
    host: "",
    port: 5432,
    database: "",
    username: "",
    password: "",
    url: "",
    headers: "{}",
  });

  // General Settings Form State
  let siteName = $state("Kitsuden CMS");
  let siteDescription = $state("");
  let siteUrl = $state("");
  /**
   * Identity of the PUBLIC site (not of this panel), with media library ids,
   * which is what `site_settings.branding` defines.
   *
   * Before, there was a "Logo URL" field that wrote a `logoUrl` that the schema does not
   * have, there was nowhere to put the favicon, and the frontend read neither of
   * the two: the brand was hand-written in the site's code.
   *
   * `branding` is saved WHOLE: the settings PATCH replaces the column, so
   * what this form does not touch (colors, the old `logoUrl`) is preserved
   * instead of being erased on save.
   */
  type BrandField = "logoId" | "faviconId" | "ogImageId";
  const BRAND_FIELDS: Array<{ key: BrandField; label: string; help: string }> = [
    {
      key: "logoId",
      label: t("settings.logo"),
      help: t("settings.siteHeaderAndFooter"),
    },
    {
      key: "faviconId",
      label: t("settings.faviconIcon"),
      help: t("settings.squareBrowserTabTo"),
    },
    {
      key: "ogImageId",
      label: t("settings.shareImage"),
      help: t("settings.previewOnNetworksAnd"),
    },
  ];
  let branding = $state<Record<string, unknown>>({});
  let choosingBrand = $state<BrandField | null>(null);

  /**
   * Group networks (Discord, Twitch, YouTube, X, Instagram, TikTok, Ko-fi…).
   * It is saved in `site_settings.social`, the SAME column the wikis already used
   * for discord/youtube/twitch: this extends it, it does not create a new
   * kon. The settings PATCH merges by column, so saving only
   * `{ social }` does not touch name, URL or branding.
   *
   * `youtubeChannels` feeds the front page's multi-channel feed: one RSS per
   * channel, mixed and sorted by date, with the provenance visible on each
   * card. `id` is the channel identifier (UC…), not the @handle.
   */
  type YoutubeChannel = { id: string; name: string };
  type SocialFields =
    | "discord"
    | "twitch"
    | "twitter"
    | "instagram"
    | "tiktok"
    | "tiktok2"
    | "facebook"
    | "facebookGroup"
    | "whatsappGroup"
    | "kofi"
    | "github";
  const SOCIAL_FIELDS: Array<{ key: SocialFields; label: string; help: string }> = [
    {
      key: "discord",
      label: t("settings.discordInviteUrl"),
      help: "https://discord.gg/… — large card in the Community section.",
    },
    {
      key: "twitch",
      label: t("settings.channelTwitchLogin"),
      help: t("settings.onlyLoginWithoutHttps"),
    },
    {
      key: "twitter",
      label: "X / Twitter",
      help: "https://x.com/… — icon in the networks row.",
    },
    {
      key: "instagram",
      label: "Instagram",
      help: "https://instagram.com/… — icon in the networks row.",
    },
    {
      key: "tiktok",
      label: "TikTok",
      help: "https://tiktok.com/@… — icon in the networks row.",
    },
    {
      key: "tiktok2",
      label: t("settings.tiktok2Account"),
      help: "https://tiktok.com/@… — the second account, with its own icon.",
    },
    {
      key: "facebook",
      label: t("settings.facebookPage"),
      help: "https://facebook.com/… — icon in the networks row.",
    },
    {
      key: "facebookGroup",
      label: t("settings.facebookGroup"),
      help: "https://facebook.com/groups/… — card in Community and “Facebook Group” block in the posts.",
    },
    {
      key: "whatsappGroup",
      label: t("settings.whatsappGroup"),
      help: "https://chat.whatsapp.com/… — group invitations only. It appears next to the “Facebook Group” block and in Community. Turn on “Approve new participants” in the group: whoever joins sees the numbers of the others.",
    },
    {
      key: "kofi",
      label: "Ko-fi",
      help: "https://ko-fi.com/… — card in the Community section.",
    },
    {
      key: "github",
      label: "GitHub",
      help: "https://github.com/… — icon in the networks row.",
    },
  ];
  let socials = $state<Record<SocialFields, string>>({
    discord: "",
    twitch: "",
    twitter: "",
    instagram: "",
    tiktok: "",
    tiktok2: "",
    facebook: "",
    facebookGroup: "",
    whatsappGroup: "",
    kofi: "",
    github: "",
  });
  let youtubeChannels = $state<YoutubeChannel[]>([]);
  let savingSocials = $state(false);
  let socialsError = $state("");
  let socialsOk = $state(false);

  function textOf(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  function addYoutubeChannel() {
    youtubeChannels = [...youtubeChannels, { id: "", name: "" }];
  }

  function removeYoutubeChannel(index: number) {
    youtubeChannels = youtubeChannels.filter((_, i) => i !== index);
  }

  // No cropping (`fit=inside`): a logo cropped to a square loses its letters
  function brandPreview(keyValue: BrandField): string | null {
    const id = branding[keyValue];
    return typeof id === "string" && id
      ? `${API_URL}/api/media/transform/${id}?w=240&h=160&fit=inside`
      : null;
  }

  function removeMark(keyValue: BrandField) {
    const { [keyValue]: _removed, ...rest } = branding;
    branding = rest;
  }
  let defaultMetadata = $state('{\n  "description": "Powered by Kitsuden"\n}');
  let savingGeneral = $state(false);
  /** A failed save, said in the form's SaveBar; `errorSettings` is the failed load. */
  let generalSaveError = $state("");
  let loadingSettings = $state(true);
  let errorSettings = $state("");

  // API Keys Tab State
  let showCreateModal = $state(false);
  let newKeyName = $state("");
  let newKeyExpiresInStr = $state("0");
  let creatingKey = $state(false);
  let newlyGeneratedToken = $state<string | null>(null);
  let copied = $state(false);

  // MCP Tab State
  let mcpCopied = $state(false);
  const mcpUrl = `${import.meta.env.VITE_API_URL ?? ""}/api/mcp`;

  // What the two "configuration" cards show; a CodeBlock copies them whole.
  const STDIO_CONFIG = [
    '"kitsuden-cms": {',
    '  "command": "node",',
    '  "args": ["packages/mcp-server/dist/index.js"],',
    "}",
  ].join("\n");
  const HTTP_CONFIG = [`Endpoint: ${mcpUrl}`, "Auth: Bearer API_KEY"].join("\n");

  function copyMcpUrl() {
    navigator.clipboard.writeText(mcpUrl);
    mcpCopied = true;
    setTimeout(() => (mcpCopied = false), 2000);
  }

  /**
   * What was last loaded or saved, to tell whether a form has unsaved changes. `null`
   * until the settings arrive: nothing is "unsaved" before there is something to compare.
   */
  let savedGeneral = $state<string | null>(null);
  let savedSocials = $state<string | null>(null);
  const generalSnapshot = () =>
    JSON.stringify({ siteName, siteDescription, siteUrl, branding, defaultMetadata });
  const socialsSnapshot = () => JSON.stringify({ socials, youtubeChannels });
  const generalDirty = $derived(savedGeneral !== null && savedGeneral !== generalSnapshot());
  const socialsDirty = $derived(savedSocials !== null && savedSocials !== socialsSnapshot());
  const settingsDirty = $derived(generalDirty || socialsDirty);

  /** Discard: back to what was last loaded or saved. */
  function discardGeneral() {
    if (savedGeneral === null) return;
    const saved = JSON.parse(savedGeneral);
    siteName = saved.siteName;
    siteDescription = saved.siteDescription;
    siteUrl = saved.siteUrl;
    branding = saved.branding;
    defaultMetadata = saved.defaultMetadata;
    generalSaveError = "";
  }
  function discardSocials() {
    if (savedSocials === null) return;
    const saved = JSON.parse(savedSocials);
    socials = saved.socials;
    youtubeChannels = saved.youtubeChannels;
    socialsError = "";
  }

  async function loadSettings() {
    loadingSettings = true;
    errorSettings = "";
    try {
      const res = await fetch(`${API_URL}/api/settings`, { credentials: "include" });
      if (!res.ok) throw new Error(t("settings.failedToLoadSettings"));
      const data = await res.json();
      siteName = data.siteName || "Kitsuden CMS";
      siteDescription = data.siteDescription || "";
      siteUrl = data.siteUrl || "";
      branding = data.branding && typeof data.branding === "object" ? { ...data.branding } : {};
      const social =
        data.social && typeof data.social === "object"
          ? (data.social as Record<string, unknown>)
          : {};
      socials = {
        discord: textOf(social.discord),
        twitch: textOf(social.twitch),
        twitter: textOf(social.twitter),
        instagram: textOf(social.instagram),
        tiktok: textOf(social.tiktok),
        tiktok2: textOf(social.tiktok2),
        facebook: textOf(social.facebook),
        facebookGroup: textOf(social.facebookGroup),
        whatsappGroup: textOf(social.whatsappGroup),
        kofi: textOf(social.kofi),
        github: textOf(social.github),
      };
      youtubeChannels = Array.isArray(social.youtubeChannels)
        ? (social.youtubeChannels as Array<Record<string, unknown>>)
            .filter((c) => typeof c === "object" && c !== null)
            .map((c) => ({ id: textOf(c.id), name: textOf(c.name) }))
        : [];
      if (data.siteDescription) {
        defaultMetadata = JSON.stringify({ description: data.siteDescription }, null, 2);
      }
      savedGeneral = generalSnapshot();
      savedSocials = socialsSnapshot();
    } catch (err: any) {
      errorSettings = err.message || t("settings.failedToLoadSettings");
    } finally {
      loadingSettings = false;
    }
  }

  async function saveGeneralSettings(e: Event) {
    e.preventDefault();
    savingGeneral = true;
    errorSettings = "";
    generalSaveError = "";
    try {
      let metadataObj: any = {};
      try {
        metadataObj = JSON.parse(defaultMetadata);
      } catch {
        /* ignore */
      }

      const payload: any = {
        siteName: siteName || "Kitsuden CMS",
        siteDescription: siteDescription || metadataObj.description || "",
        siteUrl: siteUrl || "",
        branding: { ...branding },
      };

      const res = await fetch(`${API_URL}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || t("settings.failedToSaveSettings"));
      }

      const data = await res.json();
      siteName = data.siteName || siteName;
      siteDescription = data.siteDescription || siteDescription;
      siteUrl = data.siteUrl || siteUrl;
      if (data.branding && typeof data.branding === "object") branding = { ...data.branding };
      savedGeneral = generalSnapshot();
      // Saving used to end in silence: the button stopped spinning and that was all.
      toast.success(t("settings.saved"));
    } catch (err: any) {
      generalSaveError = err.message || t("settings.failedToSaveSettings");
    } finally {
      savingGeneral = false;
    }
  }

  async function saveSocials(e: Event) {
    e.preventDefault();
    savingSocials = true;
    socialsError = "";
    socialsOk = false;
    try {
      const payload = {
        social: {
          ...socials,
          youtubeChannels: youtubeChannels
            .map((c) => ({ id: c.id.trim(), name: c.name.trim() }))
            .filter((c) => c.id),
        },
      };
      const res = await fetch(`${API_URL}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || t("settings.failedToSaveSocialLinks"));
      }
      socialsOk = true;
      savedSocials = socialsSnapshot();
      toast.success(t("settings.saved"));
      setTimeout(() => (socialsOk = false), 3000);
    } catch (err: any) {
      socialsError = err.message || t("settings.failedToSaveSocialLinks");
    } finally {
      savingSocials = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // API KEYS FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async function fetchKeys() {
    try {
      loadingKeys = true;
      const res = await fetch(`${API_URL}/api/keys`, { credentials: "include" });
      if (!res.ok) throw new Error(t("settings.failedToLoadApiKeys"));
      keys = await res.json();
    } catch (err: any) {
      errorKeys = err.message;
    } finally {
      loadingKeys = false;
    }
  }

  async function createKey(e: Event) {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    creatingKey = true;
    errorKeys = null;

    let expiresInDays: number | null = Number(newKeyExpiresInStr);
    if (expiresInDays === 0) expiresInDays = null; // No expiration

    try {
      const res = await fetch(`${API_URL}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: newKeyName, expiresInDays }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings.failedToCreateKey"));

      newlyGeneratedToken = data.token;
      showCreateModal = false;
      newKeyName = "";
      newKeyExpiresInStr = "0";

      // Refresh list
      await fetchKeys();
    } catch (err: any) {
      errorKeys = err.message;
    } finally {
      creatingKey = false;
    }
  }

  async function revokeKey(id: string) {
    if (!(await confirmDialog(t("settings.areYouSureYouWant")))) return;

    try {
      const res = await fetch(`${API_URL}/api/keys/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(t("settings.failedToRevokeKey"));

      keys = keys.filter((k) => k.id !== id);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTS FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadAgents() {
    loadingAgents = true;
    errorAgents = "";
    try {
      const res = await fetch(`${API_URL}/api/admin/agents`, { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        agents = data.data;
      } else {
        errorAgents = data.error || t("settings.failedToLoadAgents");
      }
    } catch (err: any) {
      errorAgents = err.message || t("settings.failedToLoadAgents");
    } finally {
      loadingAgents = false;
    }
  }

  async function createAgent() {
    try {
      const res = await fetch(`${API_URL}/api/admin/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: agentFormName,
          description: agentFormDescription,
          scopes: agentFormScopes
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
          rateLimit: agentFormRateLimit ?? 60,
          expiresInDays: agentFormExpiresInDays ?? undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        newAgentApiKey = data.data.apiKey;
        showCreateAgentModal = false;
        showNewAgentKeyModal = true;
        await loadAgents();
        resetAgentForm();
      } else {
        errorAgents = data.error || t("settings.failedToCreateAgent");
      }
    } catch (err: any) {
      errorAgents = err.message || t("settings.failedToCreateAgent");
    }
  }

  async function deleteAgent(agentId: string) {
    if (!(await confirmDialog(t("settings.areYouSureYouWant2")))) return;

    try {
      const res = await fetch(`${API_URL}/api/admin/agents/${agentId}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        await loadAgents();
        if (selectedAgent?.id === agentId) {
          showAgentDetailModal = false;
        }
      }
    } catch (err: any) {
      errorAgents = err.message || t("settings.failedToDeleteAgent");
    }
  }

  async function createAgentApiKey(agentId: string) {
    try {
      const res = await fetch(`${API_URL}/api/admin/agents/${agentId}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          expiresInDays: agentFormExpiresInDays ?? undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        newAgentApiKey = data.data.apiKey;
        showNewAgentKeyModal = true;
        await loadAgents();
        if (selectedAgent) await viewAgent(selectedAgent);
      }
    } catch (err: any) {
      errorAgents = err.message || t("settings.failedToCreateApiKey");
    }
  }

  async function revokeAgentApiKey(agentId: string, keyId: string) {
    if (!(await confirmDialog(t("settings.revokeThisApiKey")))) return;

    try {
      await fetch(`${API_URL}/api/admin/agents/${agentId}/keys/${keyId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await loadAgents();
      if (selectedAgent) await viewAgent(selectedAgent);
    } catch (err: any) {
      errorAgents = err.message || t("settings.failedToRevokeApiKey");
    }
  }

  async function viewAgent(agent: Agent) {
    selectedAgent = agent;
    showAgentDetailModal = true;
    agentDetailTab = "details";
    await Promise.all([loadAgentAuditLogs(agent.id), loadAgentStats(agent.id)]);
  }

  async function loadAgentAuditLogs(agentId: string) {
    try {
      const res = await fetch(`${API_URL}/api/admin/agents/${agentId}/logs?limit=50`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) auditLogs = data.data;
    } catch (err) {
      console.error("Failed to load audit logs:", err);
    }
  }

  async function loadAgentStats(agentId: string) {
    try {
      const res = await fetch(`${API_URL}/api/admin/agents/${agentId}/stats?days=7`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) agentStats = data.data;
    } catch (err) {
      console.error("Failed to load stats:", err);
    }
  }

  function resetAgentForm() {
    agentFormName = "";
    agentFormDescription = "";
    agentFormScopes = "mcp:connect,read:datasets";
    agentFormRateLimit = 60;
    agentFormExpiresInDays = null;
  }

  async function copyAgentKeyToClipboard(text: string) {
    await navigator.clipboard.writeText(text);
    agentKeyCopied = true;
    setTimeout(() => (agentKeyCopied = false), 2000);
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleString(localeFormat());
  }

  function scopeVariant(scope: string): "purple" | "success" | "warning" | "error" | "default" {
    if (scope.startsWith("mcp:")) return "purple";
    if (scope.startsWith("read:")) return "success";
    if (scope.startsWith("write:")) return "warning";
    if (scope.startsWith("delete:")) return "error";
    return "default";
  }

  function getActionIcon(action: string) {
    switch (action) {
      case "auth_success":
        return "✅";
      case "auth_failure":
        return "❌";
      case "mcp_connect":
        return "🔌";
      case "tool_call":
        return "🔧";
      case "rate_limited":
        return "⏱️";
      case "permission_denied":
        return "🚫";
      default:
        return "📝";
    }
  }

  async function copyToClipboard() {
    if (newlyGeneratedToken) {
      try {
        await navigator.clipboard.writeText(newlyGeneratedToken);
        copied = true;
        setTimeout(() => (copied = false), 2000);
      } catch (err) {
        // Ignored
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA SOURCES FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadDataSources() {
    loadingDataSources = true;
    errorDataSources = "";
    try {
      const res = await fetch(`${API_URL}/api/admin/data-sources`, { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        dataSources = data.data;
      } else {
        errorDataSources = data.error || t("settings.failedToLoadDataSources");
      }
    } catch (err: any) {
      errorDataSources = err.message || t("settings.failedToLoadDataSources");
    } finally {
      loadingDataSources = false;
    }
  }

  async function createDataSource() {
    try {
      const headers = dataSourceForm.headers ? JSON.parse(dataSourceForm.headers) : {};
      const payload = {
        name: dataSourceForm.name,
        type: dataSourceForm.type,
        ...(dataSourceForm.type === "api" || dataSourceForm.type === "webhook"
          ? { url: dataSourceForm.url, headers }
          : {
              host: dataSourceForm.host,
              port: dataSourceForm.port,
              database: dataSourceForm.database,
              username: dataSourceForm.username,
              password: dataSourceForm.password,
            }),
      };

      const res = await fetch(`${API_URL}/api/admin/data-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (data.success) {
        showCreateDataSourceModal = false;
        resetDataSourceForm();
        await loadDataSources();
      } else {
        errorDataSources = data.error || t("settings.failedToCreateDataSource");
      }
    } catch (err: any) {
      errorDataSources = err.message || t("settings.failedToCreateDataSource");
    }
  }

  async function testDataSourceConnection() {
    testingConnection = true;
    testResult = null;
    try {
      const headers = dataSourceForm.headers ? JSON.parse(dataSourceForm.headers) : {};
      const payload = {
        type: dataSourceForm.type,
        ...(dataSourceForm.type === "api" || dataSourceForm.type === "webhook"
          ? { url: dataSourceForm.url, headers }
          : {
              host: dataSourceForm.host,
              port: dataSourceForm.port,
              database: dataSourceForm.database,
              username: dataSourceForm.username,
              password: dataSourceForm.password,
            }),
      };

      const res = await fetch(`${API_URL}/api/admin/data-sources/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      testResult = {
        success: data.success,
        message:
          data.message ||
          (data.success ? t("settings.connectionSuccessful") : t("settings.connectionFailed")),
      };
    } catch (err: any) {
      testResult = { success: false, message: err.message || t("settings.connectionTestFailed") };
    } finally {
      testingConnection = false;
    }
  }

  async function deleteDataSource(id: string) {
    if (!(await confirmDialog(t("settings.areYouSureYouWant3")))) return;

    try {
      const res = await fetch(`${API_URL}/api/admin/data-sources/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        await loadDataSources();
      }
    } catch (err: any) {
      errorDataSources = err.message || t("settings.failedToDeleteDataSource");
    }
  }

  function resetDataSourceForm() {
    dataSourceForm = {
      name: "",
      type: "postgresql",
      host: "",
      port: 5432,
      database: "",
      username: "",
      password: "",
      url: "",
      headers: "{}",
    };
    testResult = null;
  }

  function getDataSourceIcon(type: string) {
    switch (type) {
      case "postgresql":
        return Database;
      case "mysql":
        return Database;
      case "mongodb":
        return Database;
      case "redis":
        return Server;
      case "api":
        return Globe;
      case "webhook":
        return Link2;
      default:
        return Database;
    }
  }

  function getDataSourceTypeColor(type: string): string {
    switch (type) {
      case "postgresql":
        return "text-kitsuden-info bg-kitsuden-info/10";
      case "mysql":
        return "text-kitsuden-amber bg-kitsuden-amber/10";
      case "mongodb":
        return "text-kitsuden-green bg-kitsuden-green/10";
      case "redis":
        return "text-kitsuden-danger bg-kitsuden-danger/10";
      case "api":
        return "text-kitsuden-accent bg-kitsuden-accent/10";
      case "webhook":
        return "text-kitsuden-purple bg-kitsuden-purple/10";
      default:
        return "text-kitsuden-text-dim bg-kitsuden-subtle/10";
    }
  }

  onMount(() => {
    fetchKeys();
    loadAgents();
    loadDataSources();
  });
</script>

<!-- Unsaved site details or social links: ask before leaving the page. -->
<UnsavedGuard dirty={settingsDirty} />

<Page title={t("shell.settings")} description={t("settings.configureYourCmsPreferencesAnd")}>
  <div class="space-y-6">
    <Tabs
      items={SETTINGS_TABS}
      bind:value={() => activeTab, selectTab}
      ariaLabel={t("common.settings")}
    >
      {#snippet tab(item)}
        {@const Icon = TAB_ICONS[item.id]}
        {#if Icon}<Icon class="w-4 h-4" />{/if}
        {item.label}
      {/snippet}
      <!-- Tab Content -->
      {#if activeTab === "general"}
        {#if loadingSettings}
          <div class="flex items-center justify-center py-12">
            <Spinner />
          </div>
        {:else}
          <div class="max-w-3xl space-y-8">
            {#if errorSettings}
              <Alert variant="error">{errorSettings}</Alert>
            {/if}

            <form onsubmit={saveGeneralSettings}>
              <Card>
                <CardHeader>
                  <div class="min-w-0">
                    <CardTitle level={2}>{t("settings.generalConfiguration")}</CardTitle>
                    <p class="text-sm text-kitsuden-subtle mt-1">
                      {t("settings.manageCoreSettingsForYour")}
                    </p>
                  </div>
                </CardHeader>
                <CardContent class="space-y-6">
                  <div class="space-y-1.5">
                    <Field label={t("settings.siteName")} required>
                      <Input
                        id="sitename"
                        bind:value={siteName}
                        type="text"
                        placeholder={t("settings.eGMySite")}
                        required
                      />
                    </Field>
                    <p class="text-xs text-kitsuden-text-dim">
                      {t("settings.thePublicSiteName")}
                    </p>
                  </div>

                  <Field label={t("settings.siteDescription")}>
                    <Input
                      id="sitedescription"
                      bind:value={siteDescription}
                      type="text"
                      placeholder={t("settings.shortDescriptionForSeoAnd")}
                    />
                  </Field>

                  <div class="space-y-1.5">
                    <Field label={t("settings.siteUrl")}>
                      <Input
                        id="siteurl"
                        bind:value={siteUrl}
                        type="url"
                        placeholder="https://example.com"
                      />
                    </Field>
                    <!--
                      This field is NOT decorative: the public site's addresses
                      hang from it. Changing it moves all the domain wikis, so
                      the wildcard DNS and the certificate have to follow it.
                    -->
                    <p class="text-xs text-kitsuden-text-dim">
                      {t("settings.siteUrlHelp")}
                    </p>
                  </div>

                  <div class="space-y-3">
                    <div>
                      <h3 class="text-sm font-semibold text-kitsuden-text">
                        {t("settings.publicSiteIdentity")}
                      </h3>
                      <p class="text-xs text-kitsuden-text-dim mt-1">
                        {t("settings.whatVisitorsSee")}
                      </p>
                    </div>
                    <div class="grid gap-3 sm:grid-cols-3">
                      {#each BRAND_FIELDS as field (field.key)}
                        {@const view = brandPreview(field.key)}
                        <div class="space-y-2 rounded-lg border border-kitsuden-border p-3 min-w-0">
                          <p class="text-xs font-semibold text-kitsuden-text">{field.label}</p>
                          <div
                            class="flex h-20 items-center justify-center rounded-sm bg-kitsuden-bg"
                          >
                            {#if view}
                              <img src={view} alt="" class="max-h-16 max-w-full object-contain" />
                            {:else}
                              <span class="text-xs text-kitsuden-text-dim"
                                >{t("settings.withoutChoosing")}</span
                              >
                            {/if}
                          </div>
                          <p class="text-[11px] leading-snug text-kitsuden-text-dim">
                            {field.help}
                          </p>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              type="button"
                              onclick={() => (choosingBrand = field.key)}
                            >
                              {view ? t("settings.change") : t("settings.choose")}
                            </Button>
                            {#if view}
                              <Button
                                variant="ghost"
                                size="sm"
                                type="button"
                                onclick={() => removeMark(field.key)}
                              >
                                {t("settings.remove")}
                              </Button>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>

                  <Field label={t("settings.defaultMetadataJson")}>
                    <Textarea
                      mono
                      id="defaultmetadata"
                      bind:value={defaultMetadata}
                      rows={5}
                      placeholder={t("settings.jsonMetadataForHeaders")}
                    />
                  </Field>
                </CardContent>
              </Card>

              <SaveBar
                dirty={generalDirty}
                saving={savingGeneral}
                error={generalSaveError || undefined}
                disableWhenClean
                savedText={savedGeneral !== null ? t("record.allSaved") : ""}
                saveLabel={t("settings.saveConfiguration")}
                cancelLabel={t("record.discard")}
                onCancel={generalDirty ? discardGeneral : undefined}
              />
            </form>

            <MediaPicker
              open={choosingBrand !== null}
              title={t("settings.chooseSiteImage")}
              onSelect={(medium) => {
                if (choosingBrand) branding = { ...branding, [choosingBrand]: medium.id };
                choosingBrand = null;
              }}
              onClose={() => (choosingBrand = null)}
            />

            <form onsubmit={saveSocials}>
              <Card>
                <CardHeader>
                  <div class="min-w-0">
                    <CardTitle level={2}>{t("settings.groupNetworks")}</CardTitle>
                    <p class="text-sm text-kitsuden-subtle mt-1">
                      {t("settings.discordTwitchYoutubeYEl")}
                    </p>
                  </div>
                </CardHeader>
                <CardContent class="space-y-6">
                  <div class="grid gap-4 sm:grid-cols-2">
                    {#each SOCIAL_FIELDS as field (field.key)}
                      <div class="space-y-1.5 min-w-0">
                        <Field label={field.label}>
                          <Input
                            id={`redes-${field.key}`}
                            bind:value={socials[field.key]}
                            type="text"
                          />
                        </Field>
                        <p class="text-[11px] leading-snug text-kitsuden-text-dim">{field.help}</p>
                      </div>
                    {/each}
                  </div>

                  <div class="space-y-3">
                    <div>
                      <h3 class="text-sm font-semibold text-kitsuden-text">
                        {t("settings.youtubeChannels")}
                      </h3>
                      <p class="text-xs text-kitsuden-text-dim mt-1">
                        {t("settings.latestVideosMixBlock")} <code class="font-mono">id</code>
                        {t("settings.isChannelIdentifier")}
                      </p>
                    </div>
                    {#each youtubeChannels as channel, i (i)}
                      <div class="flex flex-wrap items-end gap-2">
                        <Field class="flex-1 min-w-40" label={t("settings.visibleName")}>
                          <Input
                            bind:value={channel.name}
                            type="text"
                            placeholder={t("common.kitsuden")}
                          />
                        </Field>
                        <Field class="flex-2 min-w-48" label={t("settings.channelId")}>
                          <Input
                            class="font-mono!"
                            bind:value={channel.id}
                            type="text"
                            placeholder={t("settings.ucxxxxxxxxxxxxxxxxxxxxxx")}
                          />
                        </Field>
                        <Button
                          variant="ghost"
                          type="button"
                          onclick={() => removeYoutubeChannel(i)}
                        >
                          {t("settings.remove")}
                        </Button>
                      </div>
                    {/each}
                    <Button variant="secondary" size="sm" type="button" onclick={addYoutubeChannel}>
                      <Plus class="w-4 h-4" aria-hidden="true" />
                      {t("settings.addChannel")}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <SaveBar
                dirty={socialsDirty}
                saving={savingSocials}
                error={socialsError || undefined}
                disableWhenClean
                savedText={socialsOk
                  ? t("settings.savedNetworks")
                  : savedSocials !== null
                    ? t("record.allSaved")
                    : ""}
                saveLabel={t("settings.saveSocials")}
                cancelLabel={t("record.discard")}
                onCancel={socialsDirty ? discardSocials : undefined}
              />
            </form>
          </div>
        {/if}
      {:else if activeTab === "appearance"}
        <ThemeSelector />
      {:else if activeTab === "keys"}
        <div class="space-y-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-lg font-semibold text-kitsuden-text">
                {t("settings.machineAuthentication")}
              </h2>
              <p class="text-xs text-kitsuden-subtle mt-1">
                {t("settings.apiKeysAllowAstroN8n")}
              </p>
            </div>
            <Button onclick={() => (showCreateModal = true)}>
              <Plus class="w-4 h-4" aria-hidden="true" />
              {t("settings.createApiKey")}
            </Button>
          </div>

          {#if newlyGeneratedToken}
            <Alert variant="success" title={t("settings.apiKeyGeneratedSuccessfully")}>
              <p class="text-xs text-kitsuden-text-dim mt-1 mb-3">
                {t("settings.pleaseCopyYourApiKey")}
                <strong>{t("settings.itWillNotBeShown")}</strong>
                {t("settings.youMustIncludeItIn")}
                <code>Authorization: Bearer &lt;token&gt;</code>
                {t("settings.header")}
              </p>

              <div class="flex items-center gap-2 max-w-lg">
                <Input
                  class="font-mono! text-xs! min-w-0 flex-1"
                  type="text"
                  readonly
                  aria-label={t("settings.apiKeyGeneratedSuccessfully")}
                  value={newlyGeneratedToken}
                />
                <Button
                  variant="secondary"
                  size="icon"
                  onclick={copyToClipboard}
                  title={t("settings.copyToClipboard")}
                  ariaLabel={t("settings.copyToClipboard")}
                >
                  {#if copied}
                    <CheckCircle2 class="w-4 h-4" aria-hidden="true" />
                  {:else}
                    <Copy class="w-4 h-4" aria-hidden="true" />
                  {/if}
                </Button>
              </div>

              <div class="mt-3">
                <Button variant="ghost" size="sm" onclick={() => (newlyGeneratedToken = null)}>
                  {t("settings.iHaveCopiedMyKey")}
                </Button>
              </div>
            </Alert>
          {/if}

          {#if errorKeys}
            <Alert variant="error">{errorKeys}</Alert>
          {/if}

          {#if loadingKeys}
            <div class="flex items-center justify-center gap-2 py-12 text-kitsuden-subtle text-sm">
              <Spinner size="sm" label={t("settings.loadingKeys")} />
              <span aria-hidden="true">{t("settings.loadingKeys")}</span>
            </div>
          {:else if keys.length === 0}
            <EmptyState
              title={t("settings.noApiKeysFound")}
              description={t("settings.generateAKeyToConnect")}
              actionLabel={t("settings.createApiKey")}
              onAction={() => (showCreateModal = true)}
            />
          {:else}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.name")}</TableHead>
                  <TableHead>{t("settings.hint")}</TableHead>
                  <TableHead>{t("settings.created")}</TableHead>
                  <TableHead>{t("settings.lastUsed")}</TableHead>
                  <TableHead class="text-right!">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each keys as k}
                  <TableRow>
                    <TableCell>
                      <div class="font-medium text-kitsuden-text">{k.name}</div>
                    </TableCell>
                    <TableCell>
                      <span
                        class="font-mono text-xs bg-kitsuden-bg px-2 py-1 rounded-sm text-kitsuden-text-dim border border-kitsuden-border"
                      >
                        {k.hint}
                      </span>
                    </TableCell>
                    <TableCell class="text-kitsuden-text-dim!">
                      {new Date(k.createdAt).toLocaleDateString(localeFormat())}
                    </TableCell>
                    <TableCell class="text-kitsuden-text-dim!">
                      {k.lastUsedAt
                        ? new Date(k.lastUsedAt).toLocaleDateString(localeFormat())
                        : t("settings.never")}
                    </TableCell>
                    <TableCell class="text-right!">
                      <Button
                        variant="danger-ghost"
                        size="icon"
                        onclick={() => revokeKey(k.id)}
                        title={t("settings.revokeKey")}
                        ariaLabel={t("settings.revokeKey")}
                      >
                        <Trash2 class="w-4 h-4" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}
        </div>
      {:else if activeTab === "security"}
        <TwoFactorPanel />
      {:else if activeTab === "secrets"}
        <SecretsPanel />
      {:else if activeTab === "agents"}
        <!-- AGENTS TAB -->
        <div class="space-y-6">
          <!-- Header -->
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
                <Bot class="w-5 h-5 text-kitsuden-accent" aria-hidden="true" />
                {t("settings.agentIdentities")}
              </h2>
              <p class="text-xs text-kitsuden-subtle mt-1">
                {t("settings.manageNonHumanIdentitiesNhi")}
              </p>
            </div>
            <Button onclick={() => (showCreateAgentModal = true)}>
              <Plus class="w-4 h-4" aria-hidden="true" />
              {t("settings.createAgent")}
            </Button>
          </div>

          <!-- Error Alert -->
          {#if errorAgents}
            <Alert variant="error" onDismiss={() => (errorAgents = "")}>{errorAgents}</Alert>
          {/if}

          <!-- Agents Grid -->
          {#if loadingAgents}
            <div class="flex justify-center py-12">
              <Spinner size="lg" />
            </div>
          {:else if agents.length === 0}
            <EmptyState
              title={t("settings.noAgentsYet")}
              description={t("settings.createYourFirstAiAgent")}
              actionLabel={t("settings.createYourFirstAgent")}
              onAction={() => (showCreateAgentModal = true)}
            />
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {#each agents as agent}
                <!-- The whole card opens the agent: one large button, which the kit has no part for. -->
                <button
                  type="button"
                  onclick={() => viewAgent(agent)}
                  class="p-4 min-w-0 text-left border border-kitsuden-border rounded-xl bg-kitsuden-card hover:border-kitsuden-accent/50 focus-visible:outline-2 focus-visible:outline-kitsuden-accent transition-colors group"
                >
                  <div class="flex justify-between items-start gap-2 mb-3">
                    <h3
                      class="min-w-0 font-semibold text-lg text-kitsuden-text group-hover:text-kitsuden-accent transition-colors"
                    >
                      {agent.name}
                    </h3>
                    <Badge variant={agent.isActive ? "success" : "default"} dot>
                      {agent.isActive ? t("common.active") : t("settings.inactive")}
                    </Badge>
                  </div>

                  {#if agent.description}
                    <p class="text-kitsuden-subtle text-sm mb-3 line-clamp-2">
                      {agent.description}
                    </p>
                  {/if}

                  <div class="flex flex-wrap gap-1 mb-3">
                    {#each agent.scopes.slice(0, 3) as scope}
                      <Badge variant={scopeVariant(scope)}>{scope}</Badge>
                    {/each}
                    {#if agent.scopes.length > 3}
                      <Badge>+{agent.scopes.length - 3}</Badge>
                    {/if}
                  </div>

                  <div class="flex justify-between items-center text-sm text-kitsuden-subtle">
                    <span class="flex items-center gap-1">
                      <Key class="w-4 h-4" aria-hidden="true" />
                      {t("settings.key", { keysCount: agent.keys.length })}{agent.keys.length !== 1
                        ? "s"
                        : ""}
                    </span>
                    <span>{agent.rateLimit} {t("settings.reqMin")}</span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === "mcp"}
        <div class="space-y-6">
          <!-- Header -->
          <div class="min-w-0">
            <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
              <LibraryBig class="w-5 h-5 text-kitsuden-accent" aria-hidden="true" />
              {t("settings.mcpCapabilities")}
            </h2>
            <p class="text-sm text-kitsuden-subtle mt-1">
              {t("settings.modelContextProtocolIntegrationFor")}
            </p>
          </div>

          <!-- SSE Connection Endpoint -->
          <Card>
            <CardHeader>
              <div class="min-w-0">
                <CardTitle level={3}>{t("settings.sseConnectionEndpoint")}</CardTitle>
                <p class="text-sm text-kitsuden-subtle mt-1">
                  {t("settings.useThisSseEndpointTo")}
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <div class="flex flex-wrap items-center gap-2">
                <code
                  class="flex-1 min-w-0 break-all bg-kitsuden-bg font-mono text-sm px-4 py-3 rounded-lg border border-kitsuden-border text-kitsuden-text select-all"
                >
                  {mcpUrl}
                </code>
                <Button variant="secondary" onclick={copyMcpUrl}>
                  {#if mcpCopied}
                    <Check class="w-4 h-4 text-kitsuden-green" aria-hidden="true" />
                    {t("settings.copied")}
                  {:else}
                    <Copy class="w-4 h-4" aria-hidden="true" />
                    {t("settings.copyUrl")}
                  {/if}
                </Button>
              </div>
            </CardContent>
          </Card>

          <!-- Configuration Grid -->
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <!-- Stdio Configuration -->
            <Card class="min-w-0">
              <CardHeader>
                <div class="min-w-0">
                  <CardTitle level={3}>{t("settings.stdioConfiguration")}</CardTitle>
                  <p class="text-xs text-kitsuden-text-dim mt-1">
                    {t("settings.forClaudeDesktopCursorOr")}
                  </p>
                </div>
              </CardHeader>
              <CardContent class="space-y-3">
                <CodeBlock code={STDIO_CONFIG} language="json" />
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() =>
                    toast.error(
                      "Generate an API Key from the API Keys tab to authenticate external processes."
                    )}
                >
                  <Key class="w-4 h-4" aria-hidden="true" />
                  {t("settings.viewDocs")}
                </Button>
              </CardContent>
            </Card>

            <!-- HTTP/SSE Configuration -->
            <Card class="min-w-0">
              <CardHeader>
                <div class="min-w-0">
                  <CardTitle level={3}>{t("settings.httpSseConfiguration")}</CardTitle>
                  <p class="text-xs text-kitsuden-text-dim mt-1">
                    {t("settings.forRemoteAgentsOrCloud")}
                  </p>
                </div>
              </CardHeader>
              <CardContent class="space-y-3">
                <CodeBlock code={HTTP_CONFIG} wrap />
                <Button variant="ghost" size="sm" onclick={copyMcpUrl}>
                  <Copy class="w-4 h-4" aria-hidden="true" />
                  {t("settings.copyEndpoint")}
                </Button>
              </CardContent>
            </Card>
          </div>

          <!-- Resources & Tools Grid -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card class="min-w-0">
              <CardHeader>
                <div class="min-w-0">
                  <CardTitle level={3}>{t("settings.visibleResources")}</CardTitle>
                  <p class="text-xs text-kitsuden-text-dim mt-1">
                    {t("settings.aiAgentsCanReadThese")}
                  </p>
                </div>
              </CardHeader>
              <CardContent>
                <ul
                  class="text-kitsuden-subtle space-y-2 list-disc pl-4 font-mono text-xs break-all"
                >
                  <li>{t("settings.kitsudenDatasets")}</li>
                  <li>{t("settings.kitsudenDatasetId")}</li>
                  <li>{t("settings.kitsudenGrimoires")}</li>
                </ul>
              </CardContent>
            </Card>

            <Card class="min-w-0">
              <CardHeader>
                <div class="min-w-0">
                  <CardTitle level={3}>{t("settings.callableTools")}</CardTitle>
                  <p class="text-xs text-kitsuden-text-dim mt-1">
                    {t("settings.aiAgentsHavePermissionTo")}
                  </p>
                </div>
              </CardHeader>
              <CardContent>
                <ul
                  class="text-kitsuden-subtle space-y-2 list-disc pl-4 font-mono text-xs break-all"
                >
                  <li>{t("settings.kitsudenQueryDataset")}</li>
                  <li>{t("settings.kitsudenInsertRecord")}</li>
                  <li>{t("settings.kitsudenUpdateRecord")}</li>
                  <li>{t("settings.kitsudenDeleteRecord")}</li>
                  <li>{t("settings.kitsudenListDatasets")}</li>
                  <li>{t("settings.kitsudenDispatchWorker")}</li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      {:else if activeTab === "datasources"}
        <!-- DATA SOURCES TAB -->
        <div class="space-y-6">
          <!-- Header -->
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
                <Database class="w-5 h-5 text-kitsuden-accent" aria-hidden="true" />
                {t("settings.externalDataSources")}
              </h2>
              <p class="text-xs text-kitsuden-subtle mt-1">
                {t("settings.connectToExternalDatabasesApis")}
              </p>
            </div>
            <Button
              onclick={() => {
                resetDataSourceForm();
                showCreateDataSourceModal = true;
              }}
            >
              <Plus class="w-4 h-4" aria-hidden="true" />
              {t("settings.connectSource")}
            </Button>
          </div>

          <!-- Error Alert -->
          {#if errorDataSources}
            <Alert variant="error" onDismiss={() => (errorDataSources = "")}
              >{errorDataSources}</Alert
            >
          {/if}

          <!-- Data Sources Grid -->
          {#if loadingDataSources}
            <div class="flex justify-center py-12">
              <Spinner size="lg" />
            </div>
          {:else if dataSources.length === 0}
            <EmptyState
              title={t("settings.noDataSourcesConnected")}
              description={t("settings.connectExternalDatabasesOrApis")}
              actionLabel={t("settings.connectFirstSource")}
              onAction={() => {
                resetDataSourceForm();
                showCreateDataSourceModal = true;
              }}
            />
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {#each dataSources as source}
                {@const Icon = getDataSourceIcon(source.type)}
                <Card class="p-5 min-w-0">
                  <div class="flex items-start justify-between gap-2 mb-4">
                    <div class="flex items-center gap-3 min-w-0">
                      <div
                        class="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center {getDataSourceTypeColor(
                          source.type
                        )}"
                      >
                        <Icon class="w-5 h-5" aria-hidden="true" />
                      </div>
                      <div class="min-w-0">
                        <h3 class="font-semibold text-kitsuden-text truncate">{source.name}</h3>
                        <span class="text-xs text-kitsuden-subtle uppercase">{source.type}</span>
                      </div>
                    </div>
                    <Badge variant={source.isActive ? "success" : "warning"} dot>
                      {source.isActive ? t("common.active") : t("settings.inactive")}
                    </Badge>
                  </div>

                  {#if source.host}
                    <div class="text-xs text-kitsuden-subtle mb-1">
                      <span class="text-kitsuden-text-dim">{t("settings.host")}</span>
                      {source.host}:{source.port}
                    </div>
                  {/if}
                  {#if source.database}
                    <div class="text-xs text-kitsuden-subtle mb-1">
                      <span class="text-kitsuden-text-dim">{t("settings.database")}</span>
                      {source.database}
                    </div>
                  {/if}
                  {#if source.url}
                    <div class="text-xs text-kitsuden-subtle mb-1 truncate">
                      <span class="text-kitsuden-text-dim">{t("common.url")}</span>
                      {source.url}
                    </div>
                  {/if}

                  <div
                    class="mt-4 pt-4 border-t border-kitsuden-border flex items-center justify-between gap-2"
                  >
                    <span class="text-xs text-kitsuden-subtle">
                      {source.lastSyncAt
                        ? t("settings.lastSync", {
                            v: new Date(source.lastSyncAt).toLocaleDateString(localeFormat()),
                          })
                        : t("settings.neverSynced")}
                    </span>
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      onclick={() => deleteDataSource(source.id)}
                      title={t("settings.deleteDataSource")}
                      ariaLabel={t("settings.deleteDataSource")}
                    >
                      <Trash2 class="w-4 h-4" aria-hidden="true" />
                    </Button>
                  </div>
                </Card>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === "system"}
        <!--
      SYSTEM — what administers the platform, not a kon.

      It fills the gap left by the generic table viewer when it was retired:
      users and schema status do not belong to any kon and had no
      screen anywhere. The difference is that these are two
      concrete screens with their own shape, not a grid over any table in the database.
    -->
        <div class="space-y-8">
          <section>
            <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
              <Users class="w-5 h-5 text-kitsuden-accent" aria-hidden="true" />
              {t("settings.users")}
            </h2>
            <p class="text-xs text-kitsuden-subtle mt-1 mb-4">
              {t("settings.whoCanEnterPanel")}
            </p>

            {#if loadingSystem}
              <div class="flex items-center gap-2 text-sm text-kitsuden-subtle">
                <Spinner size="sm" label={t("common.loadingEllipsis")} />
                <span aria-hidden="true">{t("common.loadingEllipsis")}</span>
              </div>
            {:else if systemError}
              <Alert variant="error">{systemError}</Alert>
            {:else}
              <div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("common.email")}</TableHead>
                      <TableHead>{t("common.name")}</TableHead>
                      <TableHead>{t("settings.role")}</TableHead>
                      <TableHead>{t("settings.high")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {#each users as u (u.id)}
                      <TableRow>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.name || "—"}</TableCell>
                        <TableCell>
                          <Select
                            size="sm"
                            value={u.role}
                            aria-label={t("settings.role")}
                            onchange={(e: Event & { currentTarget: HTMLSelectElement }) =>
                              changeRole(u.id, e.currentTarget.value)}
                          >
                            <option value="admin">{t("settings.admin")}</option>
                            <option value="editor">{t("settings.editor")}</option>
                            <option value="user">{t("settings.user")}</option>
                          </Select>
                        </TableCell>
                        <TableCell>
                          {u.createdAt
                            ? new Date(u.createdAt).toLocaleDateString(localeFormat())
                            : "—"}
                        </TableCell>
                      </TableRow>
                    {/each}
                  </TableBody>
                </Table>
              </div>
            {/if}
          </section>

          <section>
            <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
              <Database class="w-5 h-5 text-kitsuden-accent" aria-hidden="true" />
              {t("settings.schemaStatus")}
            </h2>
            <p class="text-xs text-kitsuden-subtle mt-1 mb-4">
              {t("settings.readOnlyHistoryOf")}
            </p>

            {#if status}
              <div class="grid gap-4 sm:grid-cols-3">
                <Stat label={t("settings.migrations")} value={status.migrations.total} />
                <Stat
                  label={t("settings.activeKons")}
                  value={`${status.kons.active}/${status.kons.total}`}
                />
                <Stat label={t("settings.installed")} value={status.installed.length} />
              </div>

              <p class="mt-4 mb-2 text-xs uppercase tracking-wider text-kitsuden-subtle">
                {t("settings.lastAppliedMigrations")}
              </p>
              <ul class="space-y-1 text-xs font-mono text-kitsuden-subtle break-all">
                {#each status.migrations.latest as m (m.name)}
                  <li>{m.name}{m.baselined ? t("settings.baseline") : ""}</li>
                {/each}
              </ul>
            {/if}
          </section>
        </div>
      {/if}
    </Tabs>
  </div>
</Page>

<!-- Create Modal -->
<Dialog
  open={showCreateModal}
  title={t("settings.createNewApiKey")}
  onClose={() => {
    showCreateModal = false;
    newKeyName = "";
  }}
>
  <form id="settings-new-key" onsubmit={createKey} class="space-y-4">
    <Field label={t("settings.keyName")} required>
      <Input
        id="newkeyname"
        bind:value={newKeyName}
        type="text"
        placeholder={t("settings.eGAstroFrontendSsg")}
        required
        autocomplete="off"
      />
    </Field>

    <Field label={t("settings.expiration")}>
      <Select id="newkeyexpiresinstr" bind:value={newKeyExpiresInStr}>
        <option value="0">{t("settings.neverExpire")}</option>
        <option value="7">{t("settings.n7Days")}</option>
        <option value="30">{t("settings.n30Days")}</option>
        <option value="90">{t("settings.n90Days")}</option>
        <option value="365">{t("settings.n1Year")}</option>
      </Select>
    </Field>
  </form>
  {#snippet footer()}
    <Button
      variant="ghost"
      onclick={() => {
        showCreateModal = false;
        newKeyName = "";
      }}
      disabled={creatingKey}
    >
      {t("common.cancel")}
    </Button>
    <Button
      type="submit"
      form="settings-new-key"
      loading={creatingKey}
      disabled={!newKeyName.trim()}
    >
      {creatingKey ? t("common.creating") : t("settings.createKey")}
    </Button>
  {/snippet}
</Dialog>

<!-- Create Agent Modal -->
<Dialog
  open={showCreateAgentModal}
  title={t("settings.createNewAgent")}
  size="lg"
  onClose={() => (showCreateAgentModal = false)}
>
  <div class="space-y-4">
    <div>
      <Label class="block! mb-1.5" for="agentformname">{t("common.name2")}</Label>
      <Input
        id="agentformname"
        bind:value={agentFormName}
        placeholder={t("settings.eGDevbotFrontend")}
      />
    </div>

    <div>
      <Label class="block! mb-1.5" for="agentformdescription">{t("common.description")}</Label>
      <Input
        id="agentformdescription"
        bind:value={agentFormDescription}
        placeholder={t("settings.whatDoesThisAgentDo")}
      />
    </div>

    <div>
      <Label class="block! mb-1.5" for="agentformscopes">{t("settings.scopesCommaSeparated")}</Label
      >
      <Input
        id="agentformscopes"
        bind:value={agentFormScopes}
        placeholder={t("settings.mcpConnectReadDatasetsWrite")}
      />
      <p class="text-xs text-kitsuden-subtle mt-1">
        {t("settings.examplesMcpConnectReadWrite")}
      </p>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <Label class="block! mb-1.5" for="agentformratelimit">{t("settings.rateLimitReqMin")}</Label
        >
        <NumberInput id="agentformratelimit" bind:value={agentFormRateLimit} min={1} max={10000} />
      </div>

      <div>
        <Label class="block! mb-1.5" for="agentformexpiresindays"
          >{t("settings.keyExpiresDays")}</Label
        >
        <NumberInput
          id="agentformexpiresindays"
          bind:value={agentFormExpiresInDays}
          placeholder={t("settings.keyExpiresDefault")}
          min={1}
        />
      </div>
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (showCreateAgentModal = false)}>
      {t("common.cancel")}
    </Button>
    <Button onclick={createAgent} disabled={!agentFormName}>
      {t("settings.createAgent")}
    </Button>
  {/snippet}
</Dialog>

<!-- New API Key Modal -->
<Dialog
  open={showNewAgentKeyModal}
  title={t("settings.apiKeyCreated")}
  size="lg"
  closeOnBackdrop={false}
  onClose={() => {
    showNewAgentKeyModal = false;
    newAgentApiKey = "";
  }}
>
  <p class="text-kitsuden-subtle mb-4">
    <strong class="text-kitsuden-text">{t("settings.important")}</strong>
    {t("settings.copyThisApiKeyNow")}
  </p>

  <div class="flex gap-2">
    <code
      class="flex-1 min-w-0 p-3 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm break-all text-kitsuden-text"
    >
      {newAgentApiKey}
    </code>
    <Button
      variant="secondary"
      size="icon"
      onclick={() => copyAgentKeyToClipboard(newAgentApiKey)}
      title={t("settings.copyToClipboard")}
      ariaLabel={t("settings.copyToClipboard")}
    >
      {#if agentKeyCopied}
        <Check class="w-4 h-4" aria-hidden="true" />
      {:else}
        <Copy class="w-4 h-4" aria-hidden="true" />
      {/if}
    </Button>
  </div>

  {#snippet footer()}
    <Button
      onclick={() => {
        showNewAgentKeyModal = false;
        newAgentApiKey = "";
      }}
    >
      {t("settings.iVeSavedTheKey")}
    </Button>
  {/snippet}
</Dialog>

<!-- Agent Detail Modal -->
{#if selectedAgent}
  <Dialog
    open={showAgentDetailModal}
    title={selectedAgent.name}
    size="2xl"
    onClose={() => (showAgentDetailModal = false)}
  >
    <div class="mb-4">
      <Badge
        variant={selectedAgent.isActive ? "success" : "default"}
        size="sm"
        dot={!selectedAgent.isActive}
        pulse={selectedAgent.isActive}
      >
        {selectedAgent.isActive ? t("common.active") : t("settings.inactive")}
      </Badge>
    </div>
    <Tabs
      items={AGENT_DETAIL_TABS}
      bind:value={() => agentDetailTab, (v) => (agentDetailTab = v as typeof agentDetailTab)}
      variant="pills"
      ariaLabel={selectedAgent.name}
    >
      <div class="pt-2">
        {#if agentDetailTab === "details"}
          <div class="space-y-6">
            <!-- Info -->
            <div>
              <p class="text-sm text-kitsuden-subtle mb-1">{t("common.description")}</p>
              <p class="text-kitsuden-text">
                {selectedAgent.description || t("settings.noDescription")}
              </p>
            </div>

            <!-- Scopes -->
            <div>
              <p class="text-sm text-kitsuden-subtle mb-2">{t("settings.scopes")}</p>
              <div class="flex flex-wrap gap-2">
                {#each selectedAgent.scopes as scope}
                  <Badge variant={scopeVariant(scope)} size="md">{scope}</Badge>
                {/each}
              </div>
            </div>

            <!-- Stats -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="p-4 border border-kitsuden-border rounded-lg min-w-0">
                <p class="text-sm text-kitsuden-subtle">{t("settings.rateLimit")}</p>
                <p class="text-2xl font-bold text-kitsuden-text">{selectedAgent.rateLimit}</p>
                <p class="text-xs text-kitsuden-subtle">{t("settings.requestsPerMinute")}</p>
              </div>
              <div class="p-4 border border-kitsuden-border rounded-lg min-w-0">
                <p class="text-sm text-kitsuden-subtle">{t("settings.created")}</p>
                <p class="text-kitsuden-text">{formatDate(selectedAgent.createdAt)}</p>
              </div>
            </div>

            <!-- API Keys -->
            <div>
              <div class="flex flex-wrap justify-between items-center gap-2 mb-3">
                <p class="text-sm text-kitsuden-subtle">{t("settings.apiKeys")}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => selectedAgent && createAgentApiKey(selectedAgent.id)}
                >
                  <Plus class="w-4 h-4" aria-hidden="true" />
                  {t("settings.newKey")}
                </Button>
              </div>

              {#if selectedAgent?.keys.length === 0}
                <p class="text-kitsuden-subtle text-sm">{t("settings.noApiKeys")}</p>
              {:else}
                <div class="space-y-2">
                  {#each selectedAgent?.keys || [] as key}
                    <div
                      class="flex justify-between items-center gap-2 p-3 bg-kitsuden-bg border border-kitsuden-border rounded-lg"
                    >
                      <div class="min-w-0">
                        <code class="text-sm text-kitsuden-text break-all">{key.keyPrefix}</code>
                        <p class="text-xs text-kitsuden-subtle">
                          {t("settings.created2", { v: formatDate(key.createdAt) })}
                          {#if key.lastUsedAt}
                            {t("settings.lastUsed2", { v: formatDate(key.lastUsedAt) })}
                          {/if}
                          {#if key.expiresAt}
                            {t("settings.expires", { v: formatDate(key.expiresAt) })}
                          {/if}
                        </p>
                      </div>
                      <Button
                        variant="danger-ghost"
                        size="icon"
                        onclick={() => selectedAgent && revokeAgentApiKey(selectedAgent.id, key.id)}
                        title={t("settings.revokeKey2")}
                        ariaLabel={t("settings.revokeKey2")}
                      >
                        <Trash2 class="w-4 h-4" />
                      </Button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Delete -->
            <div class="pt-4 border-t border-kitsuden-border">
              <Button
                variant="danger-ghost"
                onclick={() => selectedAgent && deleteAgent(selectedAgent.id)}
              >
                <Trash2 class="w-4 h-4" />
                {t("settings.deleteAgent")}
              </Button>
            </div>
          </div>
        {:else if agentDetailTab === "logs"}
          {#if auditLogs.length === 0}
            <p class="text-kitsuden-subtle text-center py-8">{t("settings.noAuditLogsYet")}</p>
          {:else}
            <div class="space-y-2">
              {#each auditLogs as log}
                <div
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm border border-kitsuden-border rounded-lg"
                >
                  <span class="text-lg" aria-hidden="true">{getActionIcon(log.action)}</span>
                  <Badge variant={log.success ? "success" : "error"}>{log.action}</Badge>
                  <span class="flex-1 min-w-0 break-all text-kitsuden-text"
                    >{log.resource || "-"}</span
                  >
                  <span class="text-kitsuden-subtle text-xs">{formatDate(log.createdAt)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else if agentDetailTab === "stats"}
          {#if !agentStats}
            <div class="flex items-center justify-center gap-2 py-8 text-kitsuden-subtle text-sm">
              <Spinner size="sm" label={t("settings.loadingStatistics")} />
              <span aria-hidden="true">{t("settings.loadingStatistics")}</span>
            </div>
          {:else}
            <div class="grid grid-cols-2 gap-4 mb-6">
              <Stat label={t("settings.totalCalls")} value={agentStats.totalCalls} />
              <Stat label={t("settings.successRate")} value={agentStats.successRate} />
            </div>

            {#if Object.keys(agentStats.actionsByType || {}).length > 0}
              <h4 class="font-medium text-kitsuden-text mb-3">{t("settings.actionsBreakdown")}</h4>
              <div class="space-y-2">
                {#each Object.entries(agentStats.actionsByType) as [action, data]}
                  <div
                    class="flex flex-wrap justify-between items-center gap-2 p-3 bg-kitsuden-bg border border-kitsuden-border rounded-lg"
                  >
                    <span class="text-kitsuden-text capitalize">{action.replace("_", " ")}</span>
                    <div class="flex gap-2">
                      <Badge variant="success">{(data as any).success} {t("settings.ok")}</Badge>
                      {#if (data as any).failed > 0}
                        <Badge variant="error">{(data as any).failed} {t("settings.fail")}</Badge>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        {/if}
      </div>
    </Tabs>
  </Dialog>
{/if}

<!-- Create Data Source Modal -->
<Dialog
  open={showCreateDataSourceModal}
  title={t("settings.connectDataSource")}
  description={t("settings.configureConnectionToExternalDatabase")}
  size="lg"
  onClose={() => {
    showCreateDataSourceModal = false;
    resetDataSourceForm();
  }}
>
  <div class="space-y-4">
    <!-- Name -->
    <div>
      <Label class="block! mb-1.5" for="name">{t("common.name2")}</Label>
      <Input
        id="name"
        bind:value={dataSourceForm.name}
        placeholder={t("settings.eGProductionPostgresql")}
      />
    </div>

    <!-- Type -->
    <div>
      <Label class="block! mb-1.5" for="type">{t("settings.type")}</Label>
      <Select id="type" bind:value={dataSourceForm.type}>
        <option value="postgresql">{t("settings.postgresql")}</option>
        <option value="mysql">{t("settings.mysql")}</option>
        <option value="mongodb">{t("settings.mongodb")}</option>
        <option value="redis">{t("settings.redis")}</option>
        <option value="api">{t("settings.restApi")}</option>
        <option value="webhook">{t("settings.webhook")}</option>
      </Select>
    </div>

    {#if dataSourceForm.type === "api" || dataSourceForm.type === "webhook"}
      <!-- API/Webhook fields -->
      <div>
        <Label class="block! mb-1.5" for="url">{t("settings.url")}</Label>
        <Input id="url" bind:value={dataSourceForm.url} placeholder="https://api.example.com/v1" />
      </div>

      <div>
        <Label class="block! mb-1.5" for="headers">{t("settings.headersJson")}</Label>
        <Textarea
          class="font-mono!"
          id="headers"
          bind:value={dataSourceForm.headers}
          placeholder={'{ "Authorization": "Bearer token" }'}
          rows={3}
        />
      </div>
    {:else}
      <!-- Database fields -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label class="block! mb-1.5" for="host">{t("settings.host2")}</Label>
          <Input id="host" bind:value={dataSourceForm.host} placeholder="localhost" />
        </div>
        <div>
          <Label class="block! mb-1.5" for="port">{t("settings.port")}</Label>
          <NumberInput
            id="port"
            bind:value={
              () => dataSourceForm.port ?? null, (v) => (dataSourceForm.port = v ?? undefined)
            }
            min={1}
            max={65535}
          />
        </div>
      </div>

      <div>
        <Label class="block! mb-1.5" for="database">{t("settings.database2")}</Label>
        <Input id="database" bind:value={dataSourceForm.database} placeholder="mydb" />
      </div>

      <div>
        <Label class="block! mb-1.5" for="username">{t("settings.username")}</Label>
        <Input id="username" bind:value={dataSourceForm.username} placeholder="dbuser" />
      </div>

      <div>
        <Label class="block! mb-1.5" for="password">{t("common.password")}</Label>
        <Input
          id="password"
          type="password"
          bind:value={dataSourceForm.password}
          placeholder="••••••••"
        />
      </div>
    {/if}

    <!-- Test Result -->
    {#if testResult}
      <Alert variant={testResult.success ? "success" : "error"}>{testResult.message}</Alert>
    {/if}
  </div>

  {#snippet footer()}
    <Button
      variant="ghost"
      onclick={() => {
        showCreateDataSourceModal = false;
        resetDataSourceForm();
      }}
    >
      {t("common.cancel")}
    </Button>
    <Button variant="secondary" onclick={testDataSourceConnection} loading={testingConnection}>
      {#if testingConnection}
        {t("settings.testing")}
      {:else}
        <TestTube class="w-4 h-4" aria-hidden="true" />
        {t("settings.testConnection")}
      {/if}
    </Button>
    <Button
      onclick={createDataSource}
      disabled={!dataSourceForm.name ||
        (dataSourceForm.type === "api" || dataSourceForm.type === "webhook"
          ? !dataSourceForm.url
          : !dataSourceForm.host || !dataSourceForm.database)}
    >
      <Plus class="w-4 h-4" aria-hidden="true" />
      {t("settings.connect")}
    </Button>
  {/snippet}
</Dialog>
