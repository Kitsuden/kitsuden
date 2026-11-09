<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import {
    Settings,
    Key,
    Plus,
    Trash2,
    Copy,
    CheckCircle2,
    ShieldAlert,
    Palette,
    Cpu,
    Bot,
    RefreshCw,
    X,
    AlertCircle,
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
  import Input from "$lib/components/ui/Input.svelte";
  import Label from "$lib/components/ui/Label.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import Modal from "$lib/components/ui/Modal.svelte";
  import Select from "$lib/components/ui/Select.svelte";
  import Textarea from "$lib/components/ui/Textarea.svelte";
  import {
    Alert,
    Button,
    NumberInput,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    type TabItem,
  } from "$lib/tallao";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  // State - Read tab from URL parameter
  let activeTab = $state("general");

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
        alert([body.error, body.message].filter(Boolean).join("\n\n"));
        await loadSystem();
        return;
      }

      users = users.map((u) => (u.id === id ? { ...u, role } : u));
    } catch (err) {
      alert(t("settings.couldNotChangeThe", { err: err instanceof Error ? err.message : err }));
    }
  }

  // Initialize tab from URL on mount
  onMount(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get("tab");
    if (
      tabParam &&
      [
        "general",
        "appearance",
        "security",
        "keys",
        "secrets",
        "agents",
        "mcp",
        "datasources",
      ].includes(tabParam)
    ) {
      activeTab = tabParam;
    }
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

  function copyMcpUrl() {
    navigator.clipboard.writeText(mcpUrl);
    mcpCopied = true;
    setTimeout(() => (mcpCopied = false), 2000);
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
    } catch (err: any) {
      errorSettings = err.message || t("settings.failedToSaveSettings");
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
    if (!confirm(t("settings.areYouSureYouWant"))) return;

    try {
      const res = await fetch(`${API_URL}/api/keys/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(t("settings.failedToRevokeKey"));

      keys = keys.filter((k) => k.id !== id);
    } catch (err: any) {
      alert(err.message);
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
    if (!confirm(t("settings.areYouSureYouWant2"))) return;

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
    if (!confirm(t("settings.revokeThisApiKey"))) return;

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

  function getScopeColor(scope: string): string {
    if (scope.startsWith("mcp:")) return "bg-purple-500/20 text-purple-400";
    if (scope.startsWith("read:")) return "bg-green-500/20 text-green-400";
    if (scope.startsWith("write:")) return "bg-amber-500/20 text-amber-400";
    if (scope.startsWith("delete:")) return "bg-red-500/20 text-red-400";
    return "bg-gray-500/20 text-gray-400";
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
    if (!confirm(t("settings.areYouSureYouWant3"))) return;

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
        return "text-blue-400 bg-blue-500/10";
      case "mysql":
        return "text-amber-400 bg-amber-500/10";
      case "mongodb":
        return "text-green-400 bg-green-500/10";
      case "redis":
        return "text-red-400 bg-red-500/10";
      case "api":
        return "text-kitsuden-accent bg-kitsuden-accent/10";
      case "webhook":
        return "text-purple-400 bg-purple-500/10";
      default:
        return "text-gray-400 bg-gray-500/10";
    }
  }

  onMount(() => {
    fetchKeys();
    loadAgents();
    loadDataSources();
  });
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-green/20 to-kitsuden-accent/20 border border-kitsuden-green/20 flex items-center justify-center"
        >
          <Settings class="w-5 h-5 text-kitsuden-green" />
        </div>
        {t("common.settings")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("settings.configureYourCmsPreferencesAnd")}
      </p>
    </div>
  </div>

  <Tabs items={SETTINGS_TABS} bind:value={activeTab} ariaLabel={t("common.settings")}>
    {#snippet tab(item)}
      {@const Icon = TAB_ICONS[item.id]}
      {#if Icon}<Icon class="w-4 h-4" />{/if}
      {item.label}
    {/snippet}
    <!-- Tab Content -->
    {#if activeTab === "general"}
      <div class="card p-8 animate-fade-in border border-kitsuden-border">
        <div class="mb-6">
          <h2 class="text-xl font-bold text-kitsuden-text">{t("settings.generalConfiguration")}</h2>
          <p class="text-sm text-kitsuden-subtle mt-1">
            {t("settings.manageCoreSettingsForYour")}
          </p>
        </div>

        {#if loadingSettings}
          <div class="flex items-center justify-center py-12">
            <div
              class="w-6 h-6 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
            ></div>
          </div>
        {:else}
          {#if errorSettings}
            <div
              class="mb-6 p-3 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/30 text-kitsuden-accent-2 text-sm flex items-center gap-2"
            >
              <AlertCircle class="w-4 h-4 shrink-0" />
              {errorSettings}
            </div>
          {/if}
          <form onsubmit={saveGeneralSettings} class="space-y-6 max-w-2xl">
            <div class="space-y-2">
              <label
                for="sitename"
                class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
              >
                {t("settings.siteName")}
              </label>
              <Input
                id="sitename"
                bind:value={siteName}
                type="text"
                placeholder={t("settings.eGMySite")}
                required
              />
              <p class="text-xs text-kitsuden-text-dim">
                {t("settings.thePublicSiteName")}
              </p>
            </div>

            <div class="space-y-2">
              <label
                for="sitedescription"
                class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
              >
                {t("settings.siteDescription")}
              </label>
              <Input
                id="sitedescription"
                bind:value={siteDescription}
                type="text"
                placeholder={t("settings.shortDescriptionForSeoAnd")}
              />
            </div>

            <div class="space-y-2">
              <label
                for="siteurl"
                class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
              >
                {t("settings.siteUrl")}
              </label>
              <Input
                id="siteurl"
                bind:value={siteUrl}
                type="url"
                placeholder="https://example.com"
              />
              <!--
              This field is NOT decorative: the public site's addresses
              hang from it. Changing it moves all the domain wikis, so
              the wildcard DNS and the certificate have to follow it.
            -->
              <p class="text-xs text-kitsuden-text-dim">
                {t("settings.sitePublicAddressEach")}
                <code class="font-mono"
                  >&lt;wiki&gt;.{siteUrl
                    ? siteUrl
                        .replace(/^https?:\/\//, "")
                        .replace(/^www\./, "")
                        .replace(/\/+$/, "")
                    : "this-domain"}</code
                >
                {t("settings.andEachGameIn")} <code class="font-mono">/&lt;game&gt;/</code>{t(
                  "settings.changingItMovesAllWikis"
                )}
              </p>
            </div>

            <div class="space-y-3">
              <p
                class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
              >
                {t("settings.publicSiteIdentity")}
              </p>
              <p class="text-xs text-kitsuden-text-dim">
                {t("settings.whatVisitorsSee")}
              </p>
              <div class="grid gap-3 sm:grid-cols-3">
                {#each BRAND_FIELDS as field (field.key)}
                  {@const view = brandPreview(field.key)}
                  <div class="space-y-2 rounded-lg border border-kitsuden-border p-3">
                    <p class="text-xs font-semibold text-kitsuden-text">{field.label}</p>
                    <div class="flex h-20 items-center justify-center rounded-sm bg-kitsuden-bg">
                      {#if view}
                        <img src={view} alt="" class="max-h-16 max-w-full object-contain" />
                      {:else}
                        <span class="text-xs text-kitsuden-text-dim"
                          >{t("settings.withoutChoosing")}</span
                        >
                      {/if}
                    </div>
                    <p class="text-[11px] leading-snug text-kitsuden-text-dim">{field.help}</p>
                    <div class="flex gap-2">
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

            <MediaPicker
              open={choosingBrand !== null}
              title={t("settings.chooseSiteImage")}
              onSelect={(medium) => {
                if (choosingBrand) branding = { ...branding, [choosingBrand]: medium.id };
                choosingBrand = null;
              }}
              onClose={() => (choosingBrand = null)}
            />

            <div class="space-y-2">
              <label
                for="defaultmetadata"
                class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
              >
                {t("settings.defaultMetadataJson")}
              </label>
              <Textarea
                class="font-mono!"
                id="defaultmetadata"
                bind:value={defaultMetadata}
                rows={5}
                placeholder={t("settings.jsonMetadataForHeaders")}
              />
            </div>

            <div class="pt-4 border-t border-kitsuden-border">
              <Button type="submit" disabled={savingGeneral}>
                {#if savingGeneral}
                  <div
                    class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2 inline-block"
                  ></div>
                  {t("common.saving")}
                {:else}
                  {t("settings.saveConfiguration")}
                {/if}
              </Button>
            </div>
          </form>

          <form
            onsubmit={saveSocials}
            class="mt-10 space-y-6 max-w-2xl border-t border-kitsuden-border pt-6"
          >
            <div>
              <h3 class="text-lg font-semibold text-kitsuden-text">
                {t("settings.groupNetworks")}
              </h3>
              <p class="text-sm text-kitsuden-text-dim mt-1">
                {t("settings.discordTwitchYoutubeYEl")}
              </p>
            </div>

            {#if socialsError}
              <div
                class="p-3 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/30 text-kitsuden-accent-2 text-sm flex items-center gap-2"
              >
                <AlertCircle class="w-4 h-4 shrink-0" />
                {socialsError}
              </div>
            {/if}
            {#if socialsOk}
              <div
                class="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm"
              >
                {t("settings.savedNetworks")}
              </div>
            {/if}

            <div class="grid gap-4 sm:grid-cols-2">
              {#each SOCIAL_FIELDS as field (field.key)}
                <div class="space-y-2">
                  <label
                    for={`redes-${field.key}`}
                    class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
                  >
                    {field.label}
                  </label>
                  <Input id={`redes-${field.key}`} bind:value={socials[field.key]} type="text" />
                  <p class="text-[11px] leading-snug text-kitsuden-text-dim">{field.help}</p>
                </div>
              {/each}
            </div>

            <div class="space-y-3">
              <p
                class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
              >
                {t("settings.youtubeChannels")}
              </p>
              <p class="text-xs text-kitsuden-text-dim">
                {t("settings.latestVideosMixBlock")} <code class="font-mono">id</code>
                {t("settings.isChannelIdentifier")}
              </p>
              {#each youtubeChannels as channel, i (i)}
                <div class="flex flex-wrap items-end gap-2">
                  <div class="flex-1 min-w-40 space-y-1">
                    <span class="block text-[11px] text-kitsuden-subtle"
                      >{t("settings.visibleName")}</span
                    >
                    <Input
                      bind:value={channel.name}
                      type="text"
                      placeholder={t("common.kitsuden")}
                    />
                  </div>
                  <div class="flex-2 min-w-48 space-y-1">
                    <span class="block text-[11px] text-kitsuden-subtle"
                      >{t("settings.channelId")}</span
                    >
                    <Input
                      class="font-mono!"
                      bind:value={channel.id}
                      type="text"
                      placeholder={t("settings.ucxxxxxxxxxxxxxxxxxxxxxx")}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onclick={() => removeYoutubeChannel(i)}
                  >
                    {t("settings.remove")}
                  </Button>
                </div>
              {/each}
              <Button variant="secondary" size="sm" type="button" onclick={addYoutubeChannel}>
                {t("settings.addChannel")}
              </Button>
            </div>

            <div class="pt-4 border-t border-kitsuden-border">
              <Button type="submit" disabled={savingSocials}>
                {#if savingSocials}
                  <div
                    class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2 inline-block"
                  ></div>
                  {t("settings.saving")}
                {:else}
                  {t("settings.saveSocials")}
                {/if}
              </Button>
            </div>
          </form>
        {/if}
      </div>
    {:else if activeTab === "appearance"}
      <ThemeSelector />
    {:else if activeTab === "keys"}
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-lg font-semibold text-kitsuden-text">
              {t("settings.machineAuthentication")}
            </h3>
            <p class="text-xs text-kitsuden-subtle mt-1">
              {t("settings.apiKeysAllowAstroN8n")}
            </p>
          </div>
          <Button onclick={() => (showCreateModal = true)}>
            <Plus class="w-4 h-4" />
            {t("settings.createApiKey")}
          </Button>
        </div>

        {#if newlyGeneratedToken}
          <div class="card bg-kitsuden-green-10 border-kitsuden-green-30 p-5 mt-4">
            <div class="flex items-start gap-4">
              <div
                class="w-10 h-10 rounded-full bg-kitsuden-green-20 flex items-center justify-center shrink-0"
              >
                <Key class="w-5 h-5 text-kitsuden-green" />
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="text-kitsuden-green font-medium">
                  {t("settings.apiKeyGeneratedSuccessfully")}
                </h4>
                <p class="text-xs text-kitsuden-green/80 mt-1 mb-3">
                  {t("settings.pleaseCopyYourApiKey")}
                  <strong>{t("settings.itWillNotBeShown")}</strong>
                  {t("settings.youMustIncludeItIn")}
                  <code>Authorization: Bearer &lt;token&gt;</code>
                  {t("settings.header")}
                </p>

                <div class="flex items-center gap-2 max-w-lg relative">
                  <Input
                    class="font-mono! text-xs! pr-12! text-kitsuden-green! bg-black/40! border-kitsuden-green/30!"
                    type="text"
                    readonly
                    value={newlyGeneratedToken}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-kitsuden-green!"
                    onclick={copyToClipboard}
                    title={t("settings.copyToClipboard")}
                    ariaLabel={t("settings.copyToClipboard")}
                  >
                    {#if copied}
                      <CheckCircle2 class="w-4 h-4" />
                    {:else}
                      <Copy class="w-4 h-4" />
                    {/if}
                  </Button>
                </div>

                <Button variant="ghost" class="mt-4" onclick={() => (newlyGeneratedToken = null)}>
                  {t("settings.iHaveCopiedMyKey")}
                </Button>
              </div>
            </div>
          </div>
        {/if}

        {#if errorKeys}
          <div
            class="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2"
          >
            <ShieldAlert class="w-4 h-4 shrink-0" />
            {errorKeys}
          </div>
        {/if}

        <div class="card overflow-hidden">
          {#if loadingKeys}
            <div class="p-12 text-center text-kitsuden-subtle text-sm">
              {t("settings.loadingKeys")}
            </div>
          {:else if keys.length === 0}
            <div class="p-12 text-center">
              <div
                class="w-12 h-12 rounded-full bg-kitsuden-bg flex items-center justify-center mx-auto mb-3"
              >
                <Key class="w-5 h-5 text-kitsuden-subtle" />
              </div>
              <p class="text-kitsuden-text text-sm">{t("settings.noApiKeysFound")}</p>
              <p class="text-kitsuden-subtle text-xs mt-1">
                {t("settings.generateAKeyToConnect")}
              </p>
            </div>
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
                  <TableRow class="group">
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
                        class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        onclick={() => revokeKey(k.id)}
                        title={t("settings.revokeKey")}
                        ariaLabel={t("settings.revokeKey")}
                      >
                        <Trash2 class="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}
        </div>
      </div>
    {:else if activeTab === "security"}
      <TwoFactorPanel />
    {:else if activeTab === "secrets"}
      <SecretsPanel />
    {:else if activeTab === "agents"}
      <!-- AGENTS TAB -->
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
              <Bot class="w-5 h-5 text-kitsuden-accent" />
              {t("settings.agentIdentities")}
            </h3>
            <p class="text-xs text-kitsuden-subtle mt-1">
              {t("settings.manageNonHumanIdentitiesNhi")}
            </p>
          </div>
          <Button variant="soft" onclick={() => (showCreateAgentModal = true)}>
            <Plus class="w-4 h-4" />
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
            <RefreshCw class="w-8 h-8 animate-spin text-kitsuden-accent" />
          </div>
        {:else if agents.length === 0}
          <div class="p-12 text-center border border-kitsuden-border rounded-xl bg-kitsuden-card">
            <Bot class="w-12 h-12 text-kitsuden-subtle mx-auto mb-4" />
            <h3 class="text-lg font-medium text-kitsuden-text mb-2">{t("settings.noAgentsYet")}</h3>
            <p class="text-kitsuden-subtle mb-4">
              {t("settings.createYourFirstAiAgent")}
            </p>
            <Button variant="soft" onclick={() => (showCreateAgentModal = true)}>
              {t("settings.createYourFirstAgent")}
            </Button>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {#each agents as agent}
              <button
                onclick={() => viewAgent(agent)}
                class="p-4 text-left border border-kitsuden-border rounded-xl bg-kitsuden-card hover:border-kitsuden-accent/50 transition-colors group"
              >
                <div class="flex justify-between items-start mb-3">
                  <h3
                    class="font-semibold text-lg text-kitsuden-text group-hover:text-kitsuden-accent transition-colors"
                  >
                    {agent.name}
                  </h3>
                  <span
                    class="px-2 py-0.5 text-xs rounded-full {agent.isActive
                      ? 'bg-kitsuden-green/20 text-kitsuden-green'
                      : 'bg-kitsuden-subtle/20 text-kitsuden-subtle'}"
                  >
                    {agent.isActive ? t("common.active") : t("settings.inactive")}
                  </span>
                </div>

                {#if agent.description}
                  <p class="text-kitsuden-subtle text-sm mb-3 line-clamp-2">{agent.description}</p>
                {/if}

                <div class="flex flex-wrap gap-1 mb-3">
                  {#each agent.scopes.slice(0, 3) as scope}
                    <span class="px-1.5 py-0.5 text-xs rounded-sm {getScopeColor(scope)}">
                      {scope}
                    </span>
                  {/each}
                  {#if agent.scopes.length > 3}
                    <span
                      class="px-1.5 py-0.5 text-xs rounded-sm bg-kitsuden-subtle/20 text-kitsuden-subtle"
                    >
                      +{agent.scopes.length - 3}
                    </span>
                  {/if}
                </div>

                <div class="flex justify-between items-center text-sm text-kitsuden-subtle">
                  <span class="flex items-center gap-1">
                    <Key class="w-4 h-4" />
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
      <div class="space-y-6 animate-fade-in">
        <!-- Header -->
        <div>
          <h2 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
            <div
              class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-accent/20 to-kitsuden-purple/20 border border-kitsuden-accent/20 flex items-center justify-center"
            >
              <LibraryBig class="w-5 h-5 text-kitsuden-accent" />
            </div>
            {t("settings.mcpCapabilities")}
          </h2>
          <p class="text-sm text-kitsuden-subtle mt-1">
            {t("settings.modelContextProtocolIntegrationFor")}
          </p>
        </div>

        <!-- SSE Connection Endpoint -->
        <div class="card p-6 border-l-4 border-l-kitsuden-accent">
          <h3 class="font-semibold text-lg text-kitsuden-text mb-2 flex items-center gap-2">
            <Cpu class="w-5 h-5 text-kitsuden-accent" />
            {t("settings.sseConnectionEndpoint")}
          </h3>
          <p class="text-sm text-kitsuden-subtle mb-4">
            {t("settings.useThisSseEndpointTo")}
          </p>

          <div class="flex items-center gap-2">
            <code
              class="flex-1 bg-kitsuden-bg font-mono text-sm px-4 py-3 rounded-lg border border-kitsuden-border text-kitsuden-accent select-all"
            >
              {mcpUrl}
            </code>
            <Button variant="secondary" class="px-4 py-3 min-w-[120px]" onclick={copyMcpUrl}>
              {#if mcpCopied}
                <Check class="w-4 h-4 text-kitsuden-green inline mr-1" /> {t("settings.copied")}
              {:else}
                <Copy class="w-4 h-4 inline mr-1" /> {t("settings.copyUrl")}
              {/if}
            </Button>
          </div>
        </div>

        <!-- Configuration Grid -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- Stdio Configuration -->
          <div class="card p-5">
            <h4 class="font-medium text-kitsuden-text mb-3 flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-kitsuden-accent"></span>
              {t("settings.stdioConfiguration")}
            </h4>
            <p class="text-xs text-kitsuden-text-dim mb-3">
              {t("settings.forClaudeDesktopCursorOr")}
            </p>
            <div class="p-3 rounded-lg bg-black/40 border border-kitsuden-border font-mono text-xs">
              <code class="text-kitsuden-accent block">"kitsuden-cms": {"{"}</code>
              <code class="text-kitsuden-accent block ml-4">"command": "node",</code>
              <code class="text-kitsuden-accent block ml-4"
                >"args": ["packages/mcp-server/dist/index.js"],</code
              >
              <code class="text-kitsuden-accent block">}</code>
            </div>
            <div class="mt-3 flex gap-2">
              <Button
                variant="ghost"
                onclick={() =>
                  alert(
                    "Generate an API Key from the API Keys tab to authenticate external processes."
                  )}
              >
                <Key class="w-3 h-3 inline mr-1" />
                {t("settings.viewDocs")}
              </Button>
            </div>
          </div>

          <!-- HTTP/SSE Configuration -->
          <div class="card p-5">
            <h4 class="font-medium text-kitsuden-text mb-3 flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-kitsuden-purple"></span>
              {t("settings.httpSseConfiguration")}
            </h4>
            <p class="text-xs text-kitsuden-text-dim mb-3">
              {t("settings.forRemoteAgentsOrCloud")}
            </p>
            <div
              class="p-3 rounded-lg bg-black/40 border border-kitsuden-border font-mono text-xs space-y-1"
            >
              <code class="text-kitsuden-purple block">Endpoint: {mcpUrl}</code>
              <code class="text-kitsuden-subtle block">Auth: Bearer API_KEY</code>
            </div>
            <div class="mt-3 flex gap-2">
              <Button variant="ghost" onclick={copyMcpUrl}>
                <Copy class="w-3 h-3 inline mr-1" />
                {t("settings.copyEndpoint")}
              </Button>
            </div>
          </div>
        </div>

        <!-- Resources & Tools Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="card p-5 border-t-2 border-t-kitsuden-purple/50">
            <h4 class="font-medium text-kitsuden-text mb-2 flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-kitsuden-purple"></span>
              {t("settings.visibleResources")}
            </h4>
            <p class="text-[11px] text-kitsuden-text-dim mb-3">
              {t("settings.aiAgentsCanReadThese")}
            </p>
            <ul class="text-sm text-kitsuden-subtle space-y-2 list-disc pl-4 font-mono text-xs">
              <li>{t("settings.kitsudenDatasets")}</li>
              <li>{t("settings.kitsudenDatasetId")}</li>
              <li>{t("settings.kitsudenGrimoires")}</li>
            </ul>
          </div>

          <div class="card p-5 border-t-2 border-t-kitsuden-amber/50">
            <h4 class="font-medium text-kitsuden-text mb-2 flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-kitsuden-amber"></span>
              {t("settings.callableTools")}
            </h4>
            <p class="text-[11px] text-kitsuden-text-dim mb-3">
              {t("settings.aiAgentsHavePermissionTo")}
            </p>
            <ul class="text-sm text-kitsuden-subtle space-y-2 list-disc pl-4 font-mono text-xs">
              <li>{t("settings.kitsudenQueryDataset")}</li>
              <li>{t("settings.kitsudenInsertRecord")}</li>
              <li>{t("settings.kitsudenUpdateRecord")}</li>
              <li>{t("settings.kitsudenDeleteRecord")}</li>
              <li>{t("settings.kitsudenListDatasets")}</li>
              <li>{t("settings.kitsudenDispatchWorker")}</li>
            </ul>
          </div>
        </div>
      </div>
    {:else if activeTab === "datasources"}
      <!-- DATA SOURCES TAB -->
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
              <Database class="w-5 h-5 text-kitsuden-accent" />
              {t("settings.externalDataSources")}
            </h3>
            <p class="text-xs text-kitsuden-subtle mt-1">
              {t("settings.connectToExternalDatabasesApis")}
            </p>
          </div>
          <Button
            class="group"
            onclick={() => {
              resetDataSourceForm();
              showCreateDataSourceModal = true;
            }}
          >
            <Plus class="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
            {t("settings.connectSource")}
          </Button>
        </div>

        <!-- Error Alert -->
        {#if errorDataSources}
          <Alert variant="error" onDismiss={() => (errorDataSources = "")}>{errorDataSources}</Alert
          >
        {/if}

        <!-- Data Sources Grid -->
        {#if loadingDataSources}
          <div class="flex justify-center py-12">
            <RefreshCw class="w-8 h-8 animate-spin text-kitsuden-accent" />
          </div>
        {:else if dataSources.length === 0}
          <div class="p-12 text-center border border-kitsuden-border rounded-xl bg-kitsuden-card">
            <Database class="w-12 h-12 text-kitsuden-subtle mx-auto mb-4" />
            <h3 class="text-lg font-medium text-kitsuden-text mb-2">
              {t("settings.noDataSourcesConnected")}
            </h3>
            <p class="text-kitsuden-subtle mb-6">{t("settings.connectExternalDatabasesOrApis")}</p>
            <Button
              class="group"
              onclick={() => {
                resetDataSourceForm();
                showCreateDataSourceModal = true;
              }}
            >
              <Plus class="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
              {t("settings.connectFirstSource")}
            </Button>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {#each dataSources as source}
              {@const Icon = getDataSourceIcon(source.type)}
              <div
                class="p-5 border border-kitsuden-border rounded-xl bg-kitsuden-card hover:border-kitsuden-accent/50 transition-colors group"
              >
                <div class="flex items-start justify-between mb-4">
                  <div class="flex items-center gap-3">
                    <div
                      class="w-10 h-10 rounded-lg flex items-center justify-center {getDataSourceTypeColor(
                        source.type
                      )}"
                    >
                      <Icon class="w-5 h-5" />
                    </div>
                    <div>
                      <h3 class="font-semibold text-kitsuden-text">{source.name}</h3>
                      <span class="text-xs text-kitsuden-subtle uppercase">{source.type}</span>
                    </div>
                  </div>
                  <span
                    class="w-2 h-2 rounded-full {source.isActive
                      ? 'bg-emerald-500'
                      : 'bg-amber-500'}"
                  ></span>
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
                  class="mt-4 pt-4 border-t border-kitsuden-border flex items-center justify-between"
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
                    <Trash2 class="w-4 h-4" />
                  </Button>
                </div>
              </div>
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
          <h3 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
            <Users class="w-5 h-5 text-kitsuden-accent" />
            {t("settings.users")}
          </h3>
          <p class="text-xs text-kitsuden-subtle mt-1 mb-4">
            {t("settings.whoCanEnterPanel")}
          </p>

          {#if loadingSystem}
            <p class="text-sm text-kitsuden-subtle">{t("common.loadingEllipsis")}</p>
          {:else if systemError}
            <p class="text-sm text-kitsuden-danger">{systemError}</p>
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
          <h3 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
            <Database class="w-5 h-5 text-kitsuden-accent" />
            {t("settings.schemaStatus")}
          </h3>
          <p class="text-xs text-kitsuden-subtle mt-1 mb-4">
            {t("settings.readOnlyHistoryOf")}
          </p>

          {#if status}
            <div class="grid gap-4 sm:grid-cols-3">
              <div class="card p-4">
                <p class="text-xs uppercase tracking-wider text-kitsuden-subtle">
                  {t("settings.migrations")}
                </p>
                <p class="mt-1 text-2xl font-bold">{status.migrations.total}</p>
              </div>
              <div class="card p-4">
                <p class="text-xs uppercase tracking-wider text-kitsuden-subtle">
                  {t("settings.activeKons")}
                </p>
                <p class="mt-1 text-2xl font-bold">
                  {status.kons.active}<span class="text-base text-kitsuden-subtle"
                    >/{status.kons.total}</span
                  >
                </p>
              </div>
              <div class="card p-4">
                <p class="text-xs uppercase tracking-wider text-kitsuden-subtle">
                  {t("settings.installed")}
                </p>
                <p class="mt-1 text-2xl font-bold">{status.installed.length}</p>
              </div>
            </div>

            <p class="mt-4 mb-2 text-xs uppercase tracking-wider text-kitsuden-subtle">
              {t("settings.lastAppliedMigrations")}
            </p>
            <ul class="space-y-1 text-xs font-mono text-kitsuden-subtle">
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

<!-- Create Modal -->
<Modal
  open={showCreateModal}
  title={t("settings.createNewApiKey")}
  onClose={() => {
    showCreateModal = false;
    newKeyName = "";
  }}
>
  <form onsubmit={createKey} class="space-y-4">
    <div class="space-y-1.5">
      <label
        for="newkeyname"
        class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
      >
        {t("settings.keyName")}
      </label>
      <Input
        id="newkeyname"
        bind:value={newKeyName}
        type="text"
        placeholder={t("settings.eGAstroFrontendSsg")}
        required
        autocomplete="off"
      />
    </div>

    <div class="space-y-1.5">
      <label
        for="newkeyexpiresinstr"
        class="label block text-xs font-semibold uppercase text-kitsuden-subtle tracking-wider"
      >
        {t("settings.expiration")}
      </label>
      <Select id="newkeyexpiresinstr" bind:value={newKeyExpiresInStr}>
        <option value="0">{t("settings.neverExpire")}</option>
        <option value="7">{t("settings.n7Days")}</option>
        <option value="30">{t("settings.n30Days")}</option>
        <option value="90">{t("settings.n90Days")}</option>
        <option value="365">{t("settings.n1Year")}</option>
      </Select>
    </div>

    <div class="pt-4 flex items-center justify-end gap-3 border-t border-kitsuden-border mt-6">
      <Button
        variant="ghost"
        type="button"
        onclick={() => {
          showCreateModal = false;
          newKeyName = "";
        }}
        disabled={creatingKey}
      >
        {t("common.cancel")}
      </Button>
      <Button type="submit" disabled={creatingKey || !newKeyName.trim()}>
        {creatingKey ? t("common.creating") : t("settings.createKey")}
      </Button>
    </div>
  </form>
</Modal>

<!-- Create Agent Modal -->
<Modal
  open={showCreateAgentModal}
  title={t("settings.createNewAgent")}
  size="lg"
  onClose={() => (showCreateAgentModal = false)}
>
  <div class="space-y-4">
    <div>
      <Label for="agentformname">{t("common.name2")}</Label>
      <Input
        id="agentformname"
        bind:value={agentFormName}
        placeholder={t("settings.eGDevbotFrontend")}
      />
    </div>

    <div>
      <Label for="agentformdescription">{t("common.description")}</Label>
      <Input
        id="agentformdescription"
        bind:value={agentFormDescription}
        placeholder={t("settings.whatDoesThisAgentDo")}
      />
    </div>

    <div>
      <Label for="agentformscopes">{t("settings.scopesCommaSeparated")}</Label>
      <Input
        id="agentformscopes"
        bind:value={agentFormScopes}
        placeholder={t("settings.mcpConnectReadDatasetsWrite")}
      />
      <p class="text-xs text-kitsuden-subtle mt-1">
        {t("settings.examplesMcpConnectReadWrite")}
      </p>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div>
        <Label for="agentformratelimit">{t("settings.rateLimitReqMin")}</Label>
        <NumberInput id="agentformratelimit" bind:value={agentFormRateLimit} min={1} max={10000} />
      </div>

      <div>
        <Label for="agentformexpiresindays">{t("settings.keyExpiresDays")}</Label>
        <NumberInput
          id="agentformexpiresindays"
          bind:value={agentFormExpiresInDays}
          placeholder={t("settings.keyExpiresDefault")}
          min={1}
        />
      </div>
    </div>
  </div>

  <div class="flex justify-end gap-2 mt-6">
    <Button variant="ghost" onclick={() => (showCreateAgentModal = false)}>
      {t("common.cancel")}
    </Button>
    <Button variant="soft" onclick={createAgent} disabled={!agentFormName}>
      {t("settings.createAgent")}
    </Button>
  </div>
</Modal>

<!-- New API Key Modal -->
<Modal
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

  <div class="flex gap-2 mb-6">
    <code
      class="flex-1 p-3 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm break-all text-kitsuden-text"
    >
      {newAgentApiKey}
    </code>
    <Button
      variant="soft"
      size="icon"
      onclick={() => copyAgentKeyToClipboard(newAgentApiKey)}
      title={t("settings.copyToClipboard")}
      ariaLabel={t("settings.copyToClipboard")}
    >
      {#if agentKeyCopied}
        <Check class="w-5 h-5" />
      {:else}
        <Copy class="w-5 h-5" />
      {/if}
    </Button>
  </div>

  <Button
    variant="soft"
    class="w-full"
    onclick={() => {
      showNewAgentKeyModal = false;
      newAgentApiKey = "";
    }}
  >
    {t("settings.iVeSavedTheKey")}
  </Button>
</Modal>

<!-- Agent Detail Modal -->
{#if selectedAgent}
  <Modal
    open={showAgentDetailModal}
    title={selectedAgent.name}
    size="2xl"
    onClose={() => (showAgentDetailModal = false)}
  >
    <div class="mb-4">
      <StatusBadge
        variant={selectedAgent.isActive ? "active" : "inactive"}
        size="sm"
        label={selectedAgent.isActive ? t("common.active") : t("settings.inactive")}
      />
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
              <label class="block text-sm text-kitsuden-subtle mb-1"
                >{t("common.description")}</label
              >
              <p class="text-kitsuden-text">
                {selectedAgent.description || t("settings.noDescription")}
              </p>
            </div>

            <!-- Scopes -->
            <div>
              <label class="block text-sm text-kitsuden-subtle mb-2">{t("settings.scopes")}</label>
              <div class="flex flex-wrap gap-2">
                {#each selectedAgent.scopes as scope}
                  <span class="px-2 py-1 text-sm rounded-sm {getScopeColor(scope)}">
                    {scope}
                  </span>
                {/each}
              </div>
            </div>

            <!-- Stats -->
            <div class="grid grid-cols-2 gap-4">
              <div class="p-4 border border-kitsuden-border rounded-lg">
                <p class="text-sm text-kitsuden-subtle">{t("settings.rateLimit")}</p>
                <p class="text-2xl font-bold text-kitsuden-text">{selectedAgent.rateLimit}</p>
                <p class="text-xs text-kitsuden-subtle">{t("settings.requestsPerMinute")}</p>
              </div>
              <div class="p-4 border border-kitsuden-border rounded-lg">
                <p class="text-sm text-kitsuden-subtle">{t("settings.created")}</p>
                <p class="text-kitsuden-text">{formatDate(selectedAgent.createdAt)}</p>
              </div>
            </div>

            <!-- API Keys -->
            <div>
              <div class="flex justify-between items-center mb-3">
                <label class="block text-sm text-kitsuden-subtle">{t("settings.apiKeys")}</label>
                <Button
                  variant="soft"
                  size="sm"
                  onclick={() => selectedAgent && createAgentApiKey(selectedAgent.id)}
                >
                  <Plus class="w-3 h-3" />
                  {t("settings.newKey")}
                </Button>
              </div>

              {#if selectedAgent?.keys.length === 0}
                <p class="text-kitsuden-subtle text-sm">{t("settings.noApiKeys")}</p>
              {:else}
                <div class="space-y-2">
                  {#each selectedAgent?.keys || [] as key}
                    <div
                      class="flex justify-between items-center p-3 bg-kitsuden-bg border border-kitsuden-border rounded-lg"
                    >
                      <div>
                        <code class="text-sm text-kitsuden-text">{key.keyPrefix}</code>
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
                  class="flex items-center gap-3 p-3 text-sm border border-kitsuden-border rounded-lg"
                >
                  <span class="text-lg">{getActionIcon(log.action)}</span>
                  <span
                    class="px-2 py-0.5 text-xs rounded {log.success
                      ? 'bg-kitsuden-green/20 text-kitsuden-green'
                      : 'bg-kitsuden-accent-2/20 text-kitsuden-accent-2'}"
                  >
                    {log.action}
                  </span>
                  <span class="flex-1 text-kitsuden-text">{log.resource || "-"}</span>
                  <span class="text-kitsuden-subtle text-xs">{formatDate(log.createdAt)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else if agentDetailTab === "stats"}
          {#if !agentStats}
            <p class="text-kitsuden-subtle text-center py-8">{t("settings.loadingStatistics")}</p>
          {:else}
            <div class="grid grid-cols-2 gap-4 mb-6">
              <div class="p-4 border border-kitsuden-border rounded-lg">
                <p class="text-sm text-kitsuden-subtle">{t("settings.totalCalls")}</p>
                <p class="text-2xl font-bold text-kitsuden-text">{agentStats.totalCalls}</p>
              </div>
              <div class="p-4 border border-kitsuden-border rounded-lg">
                <p class="text-sm text-kitsuden-subtle">{t("settings.successRate")}</p>
                <p class="text-2xl font-bold text-kitsuden-text">{agentStats.successRate}</p>
              </div>
            </div>

            {#if Object.keys(agentStats.actionsByType || {}).length > 0}
              <h4 class="font-medium text-kitsuden-text mb-3">{t("settings.actionsBreakdown")}</h4>
              <div class="space-y-2">
                {#each Object.entries(agentStats.actionsByType) as [action, data]}
                  <div
                    class="flex justify-between items-center p-3 bg-kitsuden-bg border border-kitsuden-border rounded-lg"
                  >
                    <span class="text-kitsuden-text capitalize">{action.replace("_", " ")}</span>
                    <div class="flex gap-2">
                      <span
                        class="px-2 py-0.5 text-xs rounded-sm bg-kitsuden-green/20 text-kitsuden-green"
                        >{(data as any).success} {t("settings.ok")}</span
                      >
                      {#if (data as any).failed > 0}
                        <span
                          class="px-2 py-0.5 text-xs rounded-sm bg-kitsuden-accent-2/20 text-kitsuden-accent-2"
                          >{(data as any).failed} {t("settings.fail")}</span
                        >
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
  </Modal>
{/if}

<!-- Create Data Source Modal -->
<Modal
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
      <Label for="name">{t("common.name2")}</Label>
      <Input
        id="name"
        bind:value={dataSourceForm.name}
        placeholder={t("settings.eGProductionPostgresql")}
      />
    </div>

    <!-- Type -->
    <div>
      <Label for="type">{t("settings.type")}</Label>
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
        <Label for="url">{t("settings.url")}</Label>
        <Input id="url" bind:value={dataSourceForm.url} placeholder="https://api.example.com/v1" />
      </div>

      <div>
        <Label for="headers">{t("settings.headersJson")}</Label>
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
      <div class="grid grid-cols-2 gap-4">
        <div>
          <Label for="host">{t("settings.host2")}</Label>
          <Input id="host" bind:value={dataSourceForm.host} placeholder="localhost" />
        </div>
        <div>
          <Label for="port">{t("settings.port")}</Label>
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
        <Label for="database">{t("settings.database2")}</Label>
        <Input id="database" bind:value={dataSourceForm.database} placeholder="mydb" />
      </div>

      <div>
        <Label for="username">{t("settings.username")}</Label>
        <Input id="username" bind:value={dataSourceForm.username} placeholder="dbuser" />
      </div>

      <div>
        <Label for="password">{t("common.password")}</Label>
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
      <div
        class="p-3 rounded-lg {testResult.success
          ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
          : 'bg-red-500/10 border border-red-500/30 text-red-400'} flex items-center gap-2"
      >
        {#if testResult.success}
          <Check class="w-4 h-4" />
        {:else}
          <AlertCircle class="w-4 h-4" />
        {/if}
        <span class="text-sm">{testResult.message}</span>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <Button
      variant="secondary"
      onclick={() => {
        showCreateDataSourceModal = false;
        resetDataSourceForm();
      }}
    >
      {t("common.cancel")}
    </Button>
    <Button
      variant="secondary"
      class="group"
      onclick={testDataSourceConnection}
      disabled={testingConnection}
    >
      {#if testingConnection}
        <RefreshCw class="w-4 h-4 animate-spin" />
        {t("settings.testing")}
      {:else}
        <TestTube class="w-4 h-4 group-hover:scale-110 transition-transform" />
        {t("settings.testConnection")}
      {/if}
    </Button>
    <Button
      class="group"
      onclick={createDataSource}
      disabled={!dataSourceForm.name ||
        (dataSourceForm.type === "api" || dataSourceForm.type === "webhook"
          ? !dataSourceForm.url
          : !dataSourceForm.host || !dataSourceForm.database)}
    >
      <Plus class="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
      {t("settings.connect")}
    </Button>
  {/snippet}
</Modal>

<style>
  :global(.bg-kitsuden-green-10) {
    background-color: rgba(16, 185, 129, 0.1);
  }
  :global(.bg-kitsuden-green-20) {
    background-color: rgba(16, 185, 129, 0.2);
  }
  :global(.border-kitsuden-green-30) {
    border-color: rgba(16, 185, 129, 0.3);
  }
  :global(.text-kitsuden-green) {
    color: rgb(16, 185, 129);
  }
</style>
