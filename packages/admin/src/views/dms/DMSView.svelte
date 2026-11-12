<script lang="ts">
  import {
    Avatar,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DropdownMenu,
    EmptyState,
    Field,
    Input,
    MenuItem,
    MenuSeparator,
    Pagination,
    Progress,
    SearchInput,
    Select,
    Sheet,
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
    toast,
    type TabItem,
  } from "$lib/tallao";
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  /**
   * DMSView - Document Management System (Django Admin Style)
   *
   * Comprehensive admin screen for Kitsuden DMS with:
   * - Category tree sidebar
   * - Document table with sorting, filtering, pagination, bulk actions
   * - Detail drawer with tabs: Metadata, Content, Versions, Comments,
   *   Diagrams, Audit, Backlinks
   * - Workflow management, notifications, stats dashboard
   */
  import {
    FileText,
    FolderTree,
    Plus,
    Eye,
    Trash2,
    CheckCircle,
    Clock,
    XCircle,
    AlertCircle,
    ChevronRight,
    ChevronDown,
    Download,
    ClipboardCheck,
    Archive,
    Save,
    Send,
    Check,
    GitCommit,
    Bell,
    Layers,
    Link2,
    FileCode,
    CheckCheck,
    Reply,
    Copy,
  } from "lucide-svelte";
  import { onMount, tick } from "svelte";
  import DOMPurify from "dompurify";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  // The DMS render and the diagrams' SVGs come from content that
  // any author of the document writes: they are sanitized before the `{@html}`.
  const cleanHtml = (html: string) => DOMPurify.sanitize(String(html ?? ""));
  const cleanSvg = (svg: string) =>
    DOMPurify.sanitize(String(svg ?? ""), { USE_PROFILES: { svg: true, svgFilters: true } });

  // ═══════════════════════════════════════════════════════════════════════════
  // TYPES
  // ═══════════════════════════════════════════════════════════════════════════

  interface Category {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    children?: Category[];
    documentCount?: number;
  }

  interface Doc {
    id: string;
    code: string;
    title: string;
    slug: string;
    description?: string;
    type: string;
    status: string;
    categoryId?: string;
    categoryName?: string;
    tags: string[];
    currentVersionNumber: number;
    updatedAt: string;
    reviewDueDate?: string;
    isTemplate?: boolean;
    visibility?: string;
    allowedUserIds?: string[];
    allowedRoleIds?: string[];
    effectiveDate?: string;
    expirationDate?: string;
    requiresAcknowledgment?: boolean;
    requiresReview?: boolean;
    currentVersion?: Version;
    versions?: Version[];
  }

  interface Version {
    id: string;
    versionNumber: number;
    status: string;
    content?: string;
    contentFormat?: string;
    createdAt: string;
    createdBy?: { id?: string; name?: string; email?: string };
    changelog?: string;
    changeType?: string;
  }

  interface Comment {
    id: string;
    content: string;
    createdAt: string;
    createdBy?: { id?: string; name?: string };
    resolved?: boolean;
    resolvedAt?: string;
    versionId?: string;
    parentId?: string;
    replies?: Comment[];
  }

  interface Diagram {
    id: string;
    name: string;
    sourceXml?: string;
    sourceJson?: string;
    renderedSvg?: string;
    mediaId?: string;
    createdAt?: string;
  }

  interface AuditEntry {
    id: string;
    action: string;
    user?: { id?: string; name?: string };
    createdAt: string;
    details?: any;
  }

  interface NotificationItem {
    id: string;
    title: string;
    message?: string;
    read: boolean;
    createdAt: string;
    documentId?: string;
    documentTitle?: string;
  }

  interface Backlink {
    id: string;
    code: string;
    title: string;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════

  const documentTypes = [
    { id: "manual", label: tr("dMSView.manual"), icon: "📖", color: "#4F46E5" },
    { id: "policy", label: tr("dMSView.policy"), icon: "📋", color: "#DC2626" },
    { id: "procedure", label: tr("dMSView.procedure"), icon: "⚙️", color: "#059669" },
    { id: "template", label: tr("dMSView.template"), icon: "📄", color: "#7C3AED" },
    { id: "guide", label: tr("dMSView.guide"), icon: "🧭", color: "#EA580C" },
    { id: "training", label: tr("dMSView.training"), icon: "🎓", color: "#0891B2" },
    { id: "report", label: tr("dMSView.report"), icon: "📊", color: "#BE185D" },
    { id: "other", label: tr("dMSView.other"), icon: "📎", color: "#6B7280" },
  ];

  const workflowStatuses = [
    { id: "draft", label: tr("dMSView.draft"), color: "#6B7280", icon: Clock },
    { id: "review_pending", label: tr("dMSView.inReview"), color: "#F59E0B", icon: ClipboardCheck },
    { id: "approved", label: tr("dMSView.approved"), color: "#10B981", icon: CheckCircle },
    { id: "published", label: tr("common.published"), color: "#3B82F6", icon: CheckCircle },
    { id: "archived", label: tr("common.archived"), color: "#8B5CF6", icon: Archive },
    { id: "deprecated", label: tr("dMSView.deprecated"), color: "#EF4444", icon: XCircle },
    { id: "changes_requested", label: tr("dMSView.changes"), color: "#F97316", icon: AlertCircle },
  ];

  const visibilityOptions = [
    { id: "public", label: tr("dMSView.public") },
    { id: "internal", label: tr("dMSView.internal") },
    { id: "restricted", label: tr("dMSView.restricted") },
    { id: "confidential", label: tr("dMSView.confidential") },
  ];

  const sortableColumns = [
    { key: "code", label: tr("dMSView.code") },
    { key: "title", label: tr("common.title") },
    { key: "type", label: tr("common.type") },
    { key: "status", label: tr("common.status") },
    { key: "categoryName", label: tr("common.category") },
    { key: "currentVersionNumber", label: tr("dMSView.version") },
    { key: "updatedAt", label: tr("dMSView.updated") },
  ];

  // ── Columns: the reader picks them (kept in this browser). Version starts hidden so the
  // table fits a 1440px window beside the category tree. Code and Title always show.
  const COLUMNS_KEY = "kitsuden.dms.columns";
  const ALWAYS_SHOWN = new Set(["code", "title"]);
  const DEFAULT_HIDDEN = ["currentVersionNumber"];
  function readHidden(): string[] {
    try {
      const raw = localStorage.getItem(COLUMNS_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(parsed)
        ? parsed.filter((k): k is string => typeof k === "string")
        : DEFAULT_HIDDEN;
    } catch {
      return DEFAULT_HIDDEN;
    }
  }
  let hiddenColumns = $state<string[]>(readHidden());
  const shownColumns = $derived(
    sortableColumns.filter((c) => ALWAYS_SHOWN.has(c.key) || !hiddenColumns.includes(c.key))
  );
  const shows = (key: string) => shownColumns.some((c) => c.key === key);
  function toggleColumn(key: string) {
    hiddenColumns = hiddenColumns.includes(key)
      ? hiddenColumns.filter((k) => k !== key)
      : [...hiddenColumns, key];
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(hiddenColumns));
    } catch {
      // Private window: the choice lasts until the page is left.
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  // Global
  // "documents" | "categories" | "templates" | "notifications" | "stats"
  let activeSection = $state<string>("documents");
  const uid = $props.id();
  let loading = $state(true);
  let saving = $state(false);

  // Categories
  let categories = $state<Category[]>([]);
  let selectedCategory = $state<Category | null>(null);
  let expandedCategories = $state<Set<string>>(new Set());

  // Documents
  let documents = $state<Doc[]>([]);
  let selectedIds = $state<Set<string>>(new Set());
  let searchQuery = $state("");
  let statusFilter = $state("");
  let typeFilter = $state("");
  let sortKey = $state<string>("updatedAt");
  let sortDir = $state<"asc" | "desc">("desc");

  // Pagination
  let currentPage = $state(1);
  let totalPages = $state(1);
  const pageSize = $state(25);
  let totalDocs = $state(0);

  // Stats
  let stats = $state<any>(null);

  // Notifications
  let notifications = $state<NotificationItem[]>([]);
  let notifPage = $state(1);
  let notifTotalPages = $state(1);

  // Drawer
  let drawerOpen = $state(false);
  let drawerDoc = $state<Doc | null>(null);
  // "metadata" | "content" | "versions" | "comments" | "diagrams" | "audit" | "backlinks"
  let drawerTab = $state<string>("metadata");
  let drawerLoading = $state(false);

  // Drawer sub-state
  let versions = $state<Version[]>([]);
  let comments = $state<Comment[]>([]);
  let diagrams = $state<Diagram[]>([]);
  let auditEntries = $state<AuditEntry[]>([]);
  let backlinks = $state<Backlink[]>([]);
  let renderedHtml = $state("");
  let contentEditor = $state("");
  let contentFormat = $state<string>("markdown");
  let commentInput = $state("");
  let replyToId = $state<string | null>(null);
  let wikiQuery = $state("");
  let wikiSuggestions = $state<Doc[]>([]);
  let showWikiDropdown = $state(false);
  let wikiCaretPos = $state(0);
  let changelogInput = $state("");
  let changeTypeInput = $state<string>("minor");
  let reviewNotes = $state("");

  // Modals
  let showCreateDocModal = $state(false);
  let showCreateCatModal = $state(false);
  let showConfirmDeleteModal = $state(false);
  let showCreateVersionModal = $state(false);
  let showCreateDiagramModal = $state(false);
  let deleteTargetIds = $state<string[]>([]);

  // Forms
  let formDoc = $state<Partial<Doc>>({});
  let newCategoryName = $state("");
  let newCategoryDescription = $state("");
  let newCategoryIcon = $state("📁");
  let newCategoryColor = $state("#6366f1");
  let newCategoryParentId = $state("");
  let newDiagramName = $state("");
  let newDiagramSource = $state("");

  // ═══════════════════════════════════════════════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════════════════════════════════════════════

  const filteredDocuments = $derived.by(() => {
    let list = [...documents];
    if (activeSection === "templates") {
      list = list.filter((d) => d.isTemplate);
    }
    // client-side sort as fallback if server doesn't support it
    list.sort((a: any, b: any) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  });

  const allSelected = $derived.by(() => {
    const visible = filteredDocuments;
    return visible.length > 0 && visible.every((d) => selectedIds.has(d.id));
  });

  const someSelected = $derived.by(() => {
    const visible = filteredDocuments;
    return visible.some((d) => selectedIds.has(d.id)) && !allSelected;
  });

  const unreadCount = $derived.by(() => notifications.filter((n) => !n.read).length);

  const sectionTabs = $derived<TabItem[]>([
    { id: "documents", label: tr("dMSView.tabDocuments") },
    { id: "categories", label: tr("dMSView.categories") },
    { id: "templates", label: tr("dMSView.tabTemplates") },
    { id: "notifications", label: tr("dMSView.tabNotifications"), count: unreadCount || undefined },
    { id: "stats", label: tr("dMSView.tabStats") },
  ]);

  const drawerTabs = $derived<TabItem[]>([
    { id: "metadata", label: tr("dMSView.tabMetadata") },
    { id: "content", label: tr("common.content") },
    { id: "versions", label: tr("dMSView.tabVersions"), count: versions.length || undefined },
    { id: "comments", label: tr("dMSView.comments"), count: comments.length || undefined },
    { id: "diagrams", label: tr("dMSView.diagrams") },
    { id: "audit", label: tr("dMSView.tabAudit") },
    { id: "backlinks", label: tr("dMSView.backlinks") },
  ]);

  /** Categories and their children, as the options of a Select. */
  const categoryOptions = $derived(
    categories.flatMap((c) => [
      { value: c.id, label: c.name },
      ...(c.children || []).map((child) => ({ value: child.id, label: `  ${child.name}` })),
    ])
  );

  const changeTypeOptions = [
    { value: "major", label: tr("dMSView.major") },
    { value: "minor", label: tr("dMSView.minor") },
    { value: "patch", label: tr("dMSView.patch") },
  ];

  // The document form: `formDoc` can lack any field, and a kit control cannot bind `undefined`.
  type DocTextKey =
    | "title"
    | "code"
    | "slug"
    | "description"
    | "type"
    | "status"
    | "categoryId"
    | "visibility"
    | "effectiveDate"
    | "reviewDueDate"
    | "expirationDate";
  const setField = (key: DocTextKey) => (e: Event) => {
    formDoc[key] = (
      e.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    ).value;
  };
  const setList = (key: "tags" | "allowedUserIds" | "allowedRoleIds") => (e: Event) => {
    formDoc[key] = (e.currentTarget as HTMLInputElement).value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  onMount(() => {
    loadCategories();
    loadDocuments();
    loadStats();
    if (activeSection === "notifications") loadNotifications();
  });

  $effect(() => {
    if (activeSection === "notifications") {
      loadNotifications();
    } else if (activeSection === "stats") {
      loadStats();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOASTS
  // ═══════════════════════════════════════════════════════════════════════════

  function showToast(message: string, type: "success" | "error" | "info" = "info") {
    if (type === "success") toast.success(message);
    else if (type === "error") toast.error(message);
    else toast.info(message);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════════════════

  async function apiFetch(path: string, opts?: RequestInit) {
    const res = await fetch(`${API_URL}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type");
    if (contentType?.includes("application/json")) return res.json();
    return res.text();
  }

  async function loadCategories() {
    try {
      const result = await apiFetch("/api/dms/categories/tree");
      categories = result.docs || [];
    } catch (e: any) {
      console.error("Failed to load categories:", e);
    }
  }

  async function loadDocuments() {
    loading = true;
    try {
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("limit", String(pageSize));
      if (selectedCategory?.id) params.set("categoryId", selectedCategory.id);
      if (searchQuery) params.set("search", searchQuery);
      if (statusFilter) params.set("status", statusFilter);
      if (typeFilter) params.set("type", typeFilter);
      const result = await apiFetch(`/api/dms/documents?${params}`);
      documents = result.docs || [];
      totalPages = result.pagination?.totalPages || 1;
      totalDocs = result.pagination?.total || documents.length;
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToLoadDocuments"), "error");
    } finally {
      loading = false;
    }
  }

  async function loadStats() {
    try {
      stats = await apiFetch("/api/dms/stats");
    } catch (e: any) {
      console.error("Failed to load stats:", e);
    }
  }

  async function loadNotifications() {
    try {
      const result = await apiFetch(
        `/api/dms/notifications?unreadOnly=true&page=${notifPage}&limit=25`
      );
      notifications = result.docs || [];
      notifTotalPages = result.pagination?.totalPages || 1;
    } catch (e: any) {
      console.error("Failed to load notifications:", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAWER & DOCUMENT DETAIL
  // ═══════════════════════════════════════════════════════════════════════════

  async function openDrawer(doc: Doc) {
    drawerOpen = true;
    drawerLoading = true;
    drawerTab = "metadata";
    try {
      const full = await apiFetch(`/api/dms/documents/${doc.id}?versions=true&relations=true`);
      drawerDoc = full;
      formDoc = { ...full };
      contentEditor = full.currentVersion?.content || "";
      contentFormat = full.currentVersion?.contentFormat || "markdown";
      await Promise.all([
        loadVersions(full.id),
        loadComments(full.id),
        loadDiagrams(full.currentVersion?.id),
        loadAuditLog(full.id),
        loadBacklinks(full.id),
        loadRenderPreview(full.slug),
      ]);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToLoadDocument"), "error");
    } finally {
      drawerLoading = false;
    }
  }

  function closeDrawer() {
    drawerOpen = false;
    drawerDoc = null;
    formDoc = {};
    versions = [];
    comments = [];
    diagrams = [];
    auditEntries = [];
    backlinks = [];
    renderedHtml = "";
    contentEditor = "";
    commentInput = "";
    replyToId = null;
  }

  async function loadRenderPreview(slug?: string) {
    if (!slug) return;
    try {
      const result = await apiFetch(`/api/dms/render/${slug}`);
      renderedHtml = result.content || result.html || result;
    } catch {
      renderedHtml = "";
    }
  }

  async function loadVersions(docId: string) {
    try {
      const result = await apiFetch(`/api/dms/documents/${docId}/versions`);
      versions = result.docs || [];
    } catch {
      versions = [];
    }
  }

  async function loadComments(docId: string) {
    try {
      const result = await apiFetch(`/api/dms/documents/${docId}/comments`);
      comments = result.docs || [];
    } catch {
      comments = [];
    }
  }

  async function loadDiagrams(versionId?: string) {
    if (!versionId) {
      diagrams = [];
      return;
    }
    try {
      const result = await apiFetch(`/api/dms/versions/${versionId}/diagrams`);
      diagrams = result.docs || [];
    } catch {
      diagrams = [];
    }
  }

  async function loadAuditLog(docId: string) {
    try {
      const result = await apiFetch(`/api/dms/audit-log?documentId=${docId}&limit=100`);
      auditEntries = result.docs || [];
    } catch {
      auditEntries = [];
    }
  }

  async function loadBacklinks(docId: string) {
    try {
      const result = await apiFetch(`/api/dms/documents/${docId}/backlinks`);
      backlinks = result.docs || [];
    } catch {
      backlinks = [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCUMENT CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async function createDocument(e: Event) {
    e.preventDefault();
    saving = true;
    try {
      const body = {
        title: formDoc.title || tr("common.untitled"),
        description: formDoc.description,
        type: formDoc.type || "manual",
        status: formDoc.status || "draft",
        categoryId: formDoc.categoryId || undefined,
        tags: Array.isArray(formDoc.tags)
          ? formDoc.tags
          : (formDoc.tags as any)
              ?.toString()
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean) || [],
        slug: formDoc.slug,
        visibility: formDoc.visibility || "internal",
        effectiveDate: formDoc.effectiveDate,
        reviewDueDate: formDoc.reviewDueDate,
        expirationDate: formDoc.expirationDate,
        requiresAcknowledgment: formDoc.requiresAcknowledgment,
        allowedUserIds: formDoc.allowedUserIds,
        allowedRoleIds: formDoc.allowedRoleIds,
      };
      const created = await apiFetch("/api/dms/documents", {
        method: "POST",
        body: JSON.stringify(body),
      });
      showToast(tr("dMSView.documentCreated"), "success");
      showCreateDocModal = false;
      formDoc = {};
      await loadDocuments();
      await loadStats();
      if (created?.id) openDrawer(created);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToCreateDocument"), "error");
    } finally {
      saving = false;
    }
  }

  async function updateDocument() {
    if (!drawerDoc) return;
    saving = true;
    try {
      const body = {
        title: formDoc.title,
        description: formDoc.description,
        type: formDoc.type,
        status: formDoc.status,
        categoryId: formDoc.categoryId || undefined,
        tags: Array.isArray(formDoc.tags)
          ? formDoc.tags
          : (formDoc.tags as any)
              ?.toString()
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean) || [],
        slug: formDoc.slug,
        visibility: formDoc.visibility,
        effectiveDate: formDoc.effectiveDate,
        reviewDueDate: formDoc.reviewDueDate,
        expirationDate: formDoc.expirationDate,
        requiresAcknowledgment: formDoc.requiresAcknowledgment,
        allowedUserIds: formDoc.allowedUserIds,
        allowedRoleIds: formDoc.allowedRoleIds,
      };
      await apiFetch(`/api/dms/documents/${drawerDoc.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      showToast(tr("dMSView.documentSaved"), "success");
      await loadDocuments();
      const updated = await apiFetch(
        `/api/dms/documents/${drawerDoc.id}?versions=true&relations=true`
      );
      drawerDoc = updated;
      formDoc = { ...updated };
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToSaveDocument"), "error");
    } finally {
      saving = false;
    }
  }

  async function deleteDocuments(ids: string[]) {
    try {
      await Promise.all(
        ids.map((id) => apiFetch(`/api/dms/documents/${id}`, { method: "DELETE" }))
      );
      showToast(tr("dMSView.documentsDeleted", { n: ids.length }), "success");
      selectedIds = new Set();
      deleteTargetIds = [];
      showConfirmDeleteModal = false;
      closeDrawer();
      await loadDocuments();
      await loadStats();
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToDelete"), "error");
    }
  }

  async function cloneFromTemplate(templateId: string) {
    try {
      const cloned = await apiFetch(`/api/dms/documents/from-template/${templateId}`, {
        method: "POST",
      });
      showToast(tr("dMSView.documentClonedFromTemplate"), "success");
      await loadDocuments();
      if (cloned?.id) openDrawer(cloned);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToClone"), "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VERSION WORKFLOW
  // ═══════════════════════════════════════════════════════════════════════════

  async function saveVersionContent() {
    if (!drawerDoc?.currentVersion?.id) return;
    saving = true;
    try {
      await apiFetch(`/api/dms/versions/${drawerDoc.currentVersion.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: contentEditor, contentFormat }),
      });
      showToast(tr("dMSView.contentSaved"), "success");
      await loadRenderPreview(drawerDoc.slug);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToSaveContent"), "error");
    } finally {
      saving = false;
    }
  }

  async function createNewVersion() {
    if (!drawerDoc) return;
    saving = true;
    try {
      await apiFetch(`/api/dms/documents/${drawerDoc.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ changeType: changeTypeInput, changelog: changelogInput }),
      });
      showToast(tr("dMSView.newVersionCreated"), "success");
      showCreateVersionModal = false;
      changelogInput = "";
      changeTypeInput = "minor";
      await loadVersions(drawerDoc.id);
      const updated = await apiFetch(
        `/api/dms/documents/${drawerDoc.id}?versions=true&relations=true`
      );
      drawerDoc = updated;
      formDoc = { ...updated };
      contentEditor = updated.currentVersion?.content || "";
      await loadDiagrams(updated.currentVersion?.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToCreateVersion"), "error");
    } finally {
      saving = false;
    }
  }

  async function submitForReview(versionId: string) {
    try {
      await apiFetch(`/api/dms/versions/${versionId}/submit`, { method: "POST" });
      showToast(tr("dMSView.submittedForReview"), "success");
      if (drawerDoc) await loadVersions(drawerDoc.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToSubmit"), "error");
    }
  }

  async function reviewVersion(versionId: string, decision: "approved" | "changes_requested") {
    try {
      await apiFetch(`/api/dms/versions/${versionId}/review`, {
        method: "POST",
        body: JSON.stringify({ decision, notes: reviewNotes }),
      });
      showToast(
        decision === "approved" ? tr("dMSView.versionApproved") : tr("dMSView.changesRequested"),
        "success"
      );
      reviewNotes = "";
      if (drawerDoc) await loadVersions(drawerDoc.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToReview"), "error");
    }
  }

  async function publishVersion(versionId: string) {
    try {
      await apiFetch(`/api/dms/versions/${versionId}/publish`, { method: "POST" });
      showToast(tr("dMSView.versionPublished"), "success");
      if (drawerDoc) {
        await loadVersions(drawerDoc.id);
        const updated = await apiFetch(
          `/api/dms/documents/${drawerDoc.id}?versions=true&relations=true`
        );
        drawerDoc = updated;
        formDoc = { ...updated };
      }
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToPublish"), "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  async function postComment() {
    if (!drawerDoc || !commentInput.trim()) return;
    try {
      await apiFetch(`/api/dms/documents/${drawerDoc.id}/comments`, {
        method: "POST",
        body: JSON.stringify({
          content: commentInput,
          versionId: drawerDoc.currentVersion?.id,
          parentId: replyToId,
        }),
      });
      commentInput = "";
      replyToId = null;
      await loadComments(drawerDoc.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToPostComment"), "error");
    }
  }

  async function resolveComment(commentId: string) {
    try {
      await apiFetch(`/api/dms/comments/${commentId}/resolve`, { method: "POST" });
      if (drawerDoc) await loadComments(drawerDoc.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToResolve"), "error");
    }
  }

  async function deleteComment(commentId: string) {
    try {
      await apiFetch(`/api/dms/comments/${commentId}`, { method: "DELETE" });
      if (drawerDoc) await loadComments(drawerDoc.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToDeleteComment"), "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGRAMS
  // ═══════════════════════════════════════════════════════════════════════════

  async function createDiagram(e: Event) {
    e.preventDefault();
    if (!drawerDoc?.currentVersion?.id) return;
    saving = true;
    try {
      await apiFetch(`/api/dms/versions/${drawerDoc.currentVersion.id}/diagrams`, {
        method: "POST",
        body: JSON.stringify({
          name: newDiagramName,
          sourceXml: newDiagramSource,
          sourceJson: undefined,
          renderedSvg: undefined,
        }),
      });
      showToast(tr("dMSView.diagramCreated"), "success");
      showCreateDiagramModal = false;
      newDiagramName = "";
      newDiagramSource = "";
      await loadDiagrams(drawerDoc.currentVersion.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToCreateDiagram"), "error");
    } finally {
      saving = false;
    }
  }

  async function deleteDiagram(diagramId: string) {
    try {
      await apiFetch(`/api/dms/diagrams/${diagramId}`, { method: "DELETE" });
      showToast(tr("dMSView.diagramDeleted"), "success");
      if (drawerDoc) await loadDiagrams(drawerDoc.currentVersion?.id);
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToDeleteDiagram"), "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async function markNotificationRead(id: string) {
    try {
      await apiFetch(`/api/dms/notifications/${id}/read`, { method: "POST" });
      notifications = notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
    } catch {}
  }

  async function markAllRead() {
    try {
      await apiFetch("/api/dms/notifications/read-all", { method: "POST" });
      notifications = notifications.map((n) => ({ ...n, read: true }));
      showToast(tr("dMSView.allMarkedAsRead"), "success");
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async function saveCategory(e: Event) {
    e.preventDefault();
    saving = true;
    try {
      await apiFetch("/api/dms/categories", {
        method: "POST",
        body: JSON.stringify({
          name: newCategoryName,
          description: newCategoryDescription,
          icon: newCategoryIcon,
          color: newCategoryColor,
          parentId: newCategoryParentId || undefined,
        }),
      });
      showToast(tr("dMSView.categoryCreated"), "success");
      showCreateCatModal = false;
      newCategoryName = "";
      newCategoryDescription = "";
      newCategoryIcon = "📁";
      newCategoryColor = "#6366f1";
      newCategoryParentId = "";
      await loadCategories();
    } catch (e: any) {
      showToast(e.message || tr("dMSView.failedToCreateCategory"), "error");
    } finally {
      saving = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WIKI-LINKS AUTOCOMPLETE
  // ═══════════════════════════════════════════════════════════════════════════

  async function searchWiki(q: string) {
    if (!q) {
      wikiSuggestions = [];
      return;
    }
    try {
      const result = await apiFetch(`/api/dms/search?q=${encodeURIComponent(q)}&limit=8`);
      wikiSuggestions = result.docs || [];
    } catch {
      wikiSuggestions = [];
    }
  }

  function onContentInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    const val = ta.value;
    const pos = ta.selectionStart;
    const before = val.slice(0, pos);
    const match = before.match(/\[\[([^\]]*)$/);
    if (match) {
      wikiQuery = match[1];
      wikiCaretPos = pos;
      showWikiDropdown = true;
      searchWiki(wikiQuery);
    } else {
      showWikiDropdown = false;
      wikiSuggestions = [];
    }
  }

  function insertWikiLink(doc: Doc) {
    const before = contentEditor.slice(0, wikiCaretPos);
    const after = contentEditor.slice(wikiCaretPos);
    const newBefore = before.replace(/\[\[[^\]]*$/, `[[${doc.code}|${doc.title}]]`);
    contentEditor = newBefore + after;
    showWikiDropdown = false;
    wikiSuggestions = [];
  }

  function insertDiagramPlaceholder() {
    const placeholder = "[[diagram:NewDiagram]]";
    const ta = document.getElementById("content-editor") as HTMLTextAreaElement | null;
    if (ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      contentEditor = contentEditor.slice(0, start) + placeholder + contentEditor.slice(end);
      tick().then(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + placeholder.length;
      });
    } else {
      contentEditor += placeholder;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BULK ACTIONS & SELECTION
  // ═══════════════════════════════════════════════════════════════════════════

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
  }

  function toggleSelectAll() {
    const visible = filteredDocuments;
    if (allSelected) {
      const next = new Set(selectedIds);
      visible.forEach((d) => next.delete(d.id));
      selectedIds = next;
    } else {
      const next = new Set(selectedIds);
      visible.forEach((d) => next.add(d.id));
      selectedIds = next;
    }
  }

  function promptBulkDelete() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    deleteTargetIds = ids;
    showConfirmDeleteModal = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SORTING
  // ═══════════════════════════════════════════════════════════════════════════

  function toggleSort(key: string) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function getStatusConfig(status?: string) {
    return workflowStatuses.find((s) => s.id === status) || workflowStatuses[0];
  }

  function getTypeConfig(type?: string) {
    return documentTypes.find((t) => t.id === type) || documentTypes[7];
  }

  function toggleCategory(cat: Category) {
    const next = new Set(expandedCategories);
    if (next.has(cat.id)) next.delete(cat.id);
    else next.add(cat.id);
    expandedCategories = next;
  }

  function selectCategory(cat: Category | null) {
    selectedCategory = cat;
    currentPage = 1;
    selectedIds = new Set();
    loadDocuments();
  }

  function formatDate(date?: string) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString(localeFormat(), {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatDateTime(date?: string) {
    if (!date) return "—";
    return new Date(date).toLocaleString(localeFormat(), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function isOverdue(date?: string) {
    if (!date) return false;
    return new Date(date) < new Date();
  }

  function statusVariant(
    status?: string
  ): "default" | "success" | "warning" | "error" | "info" | "purple" {
    switch (status) {
      case "published":
        return "info";
      case "approved":
        return "success";
      case "review_pending":
      case "changes_requested":
        return "warning";
      case "archived":
        return "purple";
      case "deprecated":
        return "error";
      default:
        return "default";
    }
  }

  function openCreateDocumentModal() {
    formDoc = { status: "draft", type: "manual", visibility: "internal" };
    showCreateDocModal = true;
  }

  function exportVersion(format: "html" | "md") {
    if (!drawerDoc?.currentVersion?.id) return;
    const url = `${API_URL}/api/dms/versions/${drawerDoc.currentVersion.id}/export/${format}`;
    window.open(url, "_blank");
  }
</script>

<ViewPage
  title={tr("dMSView.documentManagement")}
  description={tr("dMSView.versionedDocumentStorageWithApproval")}
>
  {#snippet actions()}
    {#if activeSection === "documents" || activeSection === "templates"}
      <Button variant="secondary" onclick={() => (showCreateCatModal = true)}>
        <FolderTree class="w-4 h-4" />
        {tr("dMSView.categories")}
      </Button>
      <Button onclick={openCreateDocumentModal}>
        <Plus class="w-4 h-4" />
        {tr("dMSView.newDocument")}
      </Button>
    {/if}
    {#if activeSection === "categories"}
      <Button onclick={() => (showCreateCatModal = true)}>
        <Plus class="w-4 h-4" />
        {tr("dMSView.newCategory")}
      </Button>
    {/if}
  {/snippet}

  {#snippet tabs()}
    <Tabs
      items={sectionTabs}
      bind:value={activeSection}
      panels={false}
      ariaLabel={tr("dMSView.sections")}
      onchange={() => (selectedIds = new Set())}
    />
  {/snippet}

  <div class="flex min-w-0 flex-col gap-4">
    <!-- Totals (documents and templates) -->
    {#if stats && (activeSection === "documents" || activeSection === "templates")}
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={tr("dMSView.totalDocuments")} value={stats.documents?.total || 0} />
        <Stat
          label={tr("common.published")}
          value={stats.documents?.published || 0}
          variant="success"
        />
        <Stat label={tr("dMSView.drafts")} value={stats.documents?.draft || 0} />
        <Stat
          label={tr("dMSView.upForReview")}
          value={stats.upcomingReviews?.length || 0}
          variant={stats.upcomingReviews?.length ? "warning" : "default"}
        />
        <Stat label={tr("dMSView.pending")} value={stats.pendingApprovals || unreadCount || 0} />
      </div>
    {/if}

    {#if activeSection === "documents" || activeSection === "templates"}
      <div class="flex min-w-0 flex-col gap-4 md:flex-row md:items-start">
        <!-- Categories -->
        <Card class="md:w-64 md:shrink-0">
          <CardHeader>
            <CardTitle level={2}>{tr("dMSView.categories")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex flex-col gap-1">
              <Button
                variant={selectedCategory === null ? "soft" : "ghost"}
                class="w-full justify-start"
                aria-current={selectedCategory === null ? "true" : undefined}
                onclick={() => selectCategory(null)}
              >
                <FileText class="w-4 h-4" />
                {tr("dMSView.allDocuments")}
              </Button>
              {#each categories as category}
                {@const hasChildren = !!category.children && category.children.length > 0}
                {@const expanded = expandedCategories.has(category.id)}
                <div class="flex min-w-0 items-center gap-1">
                  {#if hasChildren}
                    <Button
                      variant="ghost"
                      size="icon"
                      ariaLabel={expanded
                        ? tr("dMSView.collapseCategory", { name: category.name })
                        : tr("dMSView.expandCategory", { name: category.name })}
                      aria-expanded={expanded}
                      onclick={() => toggleCategory(category)}
                    >
                      {#if expanded}
                        <ChevronDown class="w-4 h-4" />
                      {:else}
                        <ChevronRight class="w-4 h-4" />
                      {/if}
                    </Button>
                  {/if}
                  <Button
                    variant={selectedCategory?.id === category.id ? "soft" : "ghost"}
                    class="min-w-0 flex-1 justify-start"
                    aria-current={selectedCategory?.id === category.id ? "true" : undefined}
                    onclick={() => selectCategory(category)}
                  >
                    <span aria-hidden="true">{category.icon || "📁"}</span>
                    <span class="truncate">{category.name}</span>
                    <span class="ml-auto text-xs text-kitsuden-subtle"
                      >{category.documentCount || 0}</span
                    >
                  </Button>
                </div>
                {#if expanded && hasChildren}
                  <div class="ml-4 flex flex-col gap-1 border-l border-kitsuden-border pl-2">
                    {#each category.children ?? [] as child}
                      <Button
                        variant={selectedCategory?.id === child.id ? "soft" : "ghost"}
                        size="sm"
                        class="w-full justify-start"
                        aria-current={selectedCategory?.id === child.id ? "true" : undefined}
                        onclick={() => selectCategory(child)}
                      >
                        <span aria-hidden="true">{child.icon || "📂"}</span>
                        <span class="truncate">{child.name}</span>
                      </Button>
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          </CardContent>
        </Card>

        <!-- Documents -->
        <div class="flex min-w-0 flex-1 flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <SearchInput
              class="min-w-0 flex-1 basis-56"
              placeholder={tr("dMSView.searchDocuments")}
              bind:value={searchQuery}
              oninput={() => {
                currentPage = 1;
                loadDocuments();
              }}
            />
            <Select
              width="auto"
              aria-label={tr("common.status")}
              placeholder={tr("dMSView.allStatus")}
              options={workflowStatuses.map((s) => ({ value: s.id, label: s.label }))}
              bind:value={statusFilter}
              onchange={() => {
                currentPage = 1;
                loadDocuments();
              }}
            />
            <Select
              width="auto"
              aria-label={tr("common.type")}
              placeholder={tr("dMSView.allTypes")}
              options={documentTypes.map((d) => ({ value: d.id, label: d.label }))}
              bind:value={typeFilter}
              onchange={() => {
                currentPage = 1;
                loadDocuments();
              }}
            />
            <DropdownMenu label={tr("dMSView.columns")} placement="bottom-end">
              {#snippet trigger(props)}
                <Button {...props} variant="secondary">
                  <Layers class="w-4 h-4" />
                  {tr("dMSView.columns")}
                </Button>
              {/snippet}
              {#each sortableColumns.filter((c) => !ALWAYS_SHOWN.has(c.key)) as col (col.key)}
                <MenuItem
                  checked={!hiddenColumns.includes(col.key)}
                  closeOnSelect={false}
                  onSelect={() => toggleColumn(col.key)}
                >
                  {col.label}
                </MenuItem>
              {/each}
            </DropdownMenu>
            {#if selectedIds.size > 0}
              <div class="ml-auto flex items-center gap-2">
                <span class="text-xs text-kitsuden-subtle"
                  >{selectedIds.size} {tr("common.selected")}</span
                >
                <Button variant="danger-ghost" size="sm" onclick={promptBulkDelete}>
                  <Trash2 class="w-3.5 h-3.5" />
                  {tr("common.delete")}
                </Button>
              </div>
            {/if}
          </div>

          {#if loading}
            <div class="flex justify-center py-16">
              <Spinner size="lg" />
            </div>
          {:else if filteredDocuments.length === 0}
            <EmptyState
              title={tr("dMSView.noDocumentsFound")}
              description={selectedCategory
                ? tr("dMSView.thisCategoryIsEmpty")
                : tr("dMSView.getStartedByCreatingYour")}
              actionLabel={tr("dMSView.newDocument")}
              onAction={openCreateDocumentModal}
            />
          {:else}
            <Table class="dms-docs">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Checkbox
                      ariaLabel={tr("dMSView.selectAll")}
                      checked={allSelected}
                      indeterminate={someSelected}
                      onchange={toggleSelectAll}
                    />
                  </TableHead>
                  {#each shownColumns as col (col.key)}
                    <TableHead
                      aria-sort={sortKey === col.key
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        class="-ml-2"
                        onclick={() => toggleSort(col.key)}
                      >
                        {col.label}
                        {#if sortKey === col.key}
                          <span aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span>
                        {/if}
                      </Button>
                    </TableHead>
                  {/each}
                  <TableHead class="dms-pin"
                    ><span class="sr-only">{tr("common.actions")}</span></TableHead
                  >
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each filteredDocuments as doc}
                  {@const status = getStatusConfig(doc.status)}
                  {@const type = getTypeConfig(doc.type)}
                  <TableRow>
                    <TableCell>
                      <Checkbox
                        ariaLabel={tr("dMSView.selectDocument", { title: doc.title })}
                        checked={selectedIds.has(doc.id)}
                        onchange={() => toggleSelect(doc.id)}
                      />
                    </TableCell>
                    <TableCell class="font-mono text-kitsuden-subtle whitespace-nowrap"
                      >{doc.code}</TableCell
                    >
                    <TableCell>
                      <div class="flex items-start gap-2 min-w-40">
                        {#if doc.requiresReview || isOverdue(doc.reviewDueDate)}
                          <span class="mt-0.5" title={tr("dMSView.reviewOverdue")}
                            ><AlertCircle class="w-3.5 h-3.5 shrink-0 text-kitsuden-danger" /><span
                              class="sr-only">{tr("dMSView.reviewOverdue")}</span
                            ></span
                          >
                        {/if}
                        <!-- The title opens the document, as a list's first column does. -->
                        <button type="button" class="dms-doc-link" onclick={() => openDrawer(doc)}>
                          {doc.title}
                        </button>
                      </div>
                    </TableCell>
                    {#if shows("type")}
                      <TableCell>
                        <Badge variant="secondary">
                          <span aria-hidden="true">{type.icon}</span>
                          {type.label}
                        </Badge>
                      </TableCell>
                    {/if}
                    {#if shows("status")}
                      <TableCell>
                        <Badge variant={statusVariant(doc.status)}>
                          <status.icon class="w-3 h-3" />
                          {status.label}
                        </Badge>
                      </TableCell>
                    {/if}
                    {#if shows("categoryName")}
                      <TableCell class="dms-wrap text-kitsuden-subtle"
                        >{doc.categoryName || "—"}</TableCell
                      >
                    {/if}
                    {#if shows("currentVersionNumber")}
                      <TableCell class="font-mono text-kitsuden-subtle"
                        >v{doc.currentVersionNumber}</TableCell
                      >
                    {/if}
                    {#if shows("updatedAt")}
                      <TableCell class="whitespace-nowrap text-kitsuden-subtle"
                        >{formatDate(doc.updatedAt)}</TableCell
                      >
                    {/if}
                    <TableCell class="dms-pin">
                      <DropdownMenu
                        label={tr("dMSView.actionsOf", { title: doc.title })}
                        placement="bottom-end"
                      >
                        {#snippet trigger(props)}
                          <Button
                            {...props}
                            variant="ghost"
                            size="icon"
                            class="dms-row-menu"
                            ariaLabel={tr("dMSView.actionsOf", { title: doc.title })}
                          >
                            <span aria-hidden="true">⋯</span>
                          </Button>
                        {/snippet}
                        <MenuItem onSelect={() => openDrawer(doc)}>{tr("common.edit")}</MenuItem>
                        {#if doc.isTemplate}
                          <MenuItem onSelect={() => cloneFromTemplate(doc.id)}
                            >{tr("dMSView.clone")}</MenuItem
                          >
                        {/if}
                        <MenuSeparator />
                        <MenuItem
                          variant="danger"
                          onSelect={() => {
                            deleteTargetIds = [doc.id];
                            showConfirmDeleteModal = true;
                          }}>{tr("common.delete")}</MenuItem
                        >
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}

          {#if totalPages > 1}
            <div class="flex flex-wrap items-center justify-between gap-3">
              <span class="text-xs text-kitsuden-subtle">
                {tr("dMSView.totalPageOf", { totalDocs, currentPage, totalPages })}
              </span>
              <Pagination
                bind:page={currentPage}
                pageCount={totalPages}
                onchange={() => loadDocuments()}
              />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if activeSection === "categories"}
      <div class="flex max-w-4xl flex-col gap-3">
        <h2 class="text-lg font-semibold text-kitsuden-text">{tr("dMSView.categoryTree")}</h2>
        {#if categories.length === 0}
          <EmptyState
            title={tr("dMSView.noCategoriesYet")}
            actionLabel={tr("dMSView.createCategory")}
            onAction={() => (showCreateCatModal = true)}
          />
        {:else}
          {#each categories as cat}
            <Card>
              <CardContent>
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <span class="text-2xl" aria-hidden="true">{cat.icon || "📁"}</span>
                    <div class="min-w-0">
                      <h3 class="font-semibold text-kitsuden-text">{cat.name}</h3>
                      <p class="text-xs text-kitsuden-subtle">
                        {cat.description || tr("dMSView.noDescription")}
                        {tr("dMSView.docs", { v: cat.documentCount || 0 })}
                      </p>
                    </div>
                  </div>
                  <div
                    class="h-4 w-4 shrink-0 rounded-full"
                    style="background-color: {cat.color || '#6366f1'}"
                  ></div>
                </div>
                {#if cat.children && cat.children.length > 0}
                  <div class="mt-3 flex flex-col gap-2 sm:ml-8">
                    {#each cat.children as child}
                      <div
                        class="flex items-center justify-between gap-3 rounded-lg border border-kitsuden-border bg-kitsuden-bg p-3"
                      >
                        <div class="flex min-w-0 items-center gap-3">
                          <span class="text-lg" aria-hidden="true">{child.icon || "📂"}</span>
                          <div class="min-w-0">
                            <h4 class="text-sm font-medium text-kitsuden-text">{child.name}</h4>
                            <p class="text-xs text-kitsuden-subtle">
                              {child.description || ""}
                              {tr("dMSView.docs", { v: child.documentCount || 0 })}
                            </p>
                          </div>
                        </div>
                        <div
                          class="h-3 w-3 shrink-0 rounded-full"
                          style="background-color: {child.color || '#6366f1'}"
                        ></div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </CardContent>
            </Card>
          {/each}
        {/if}
      </div>
    {/if}

    {#if activeSection === "notifications"}
      <div class="flex max-w-3xl flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-lg font-semibold text-kitsuden-text">
            {tr("dMSView.notificationInbox")}
          </h2>
          {#if unreadCount > 0}
            <Button variant="secondary" size="sm" onclick={markAllRead}>
              <CheckCheck class="w-3.5 h-3.5" />
              {tr("dMSView.markAllRead")}
            </Button>
          {/if}
        </div>
        {#if notifications.length === 0}
          <EmptyState title={tr("dMSView.noNotifications")} />
        {:else}
          {#each notifications as n}
            <Card class={n.read ? "opacity-70" : ""}>
              <CardContent>
                <div class="flex items-start gap-3">
                  <Bell class="mt-0.5 w-4 h-4 shrink-0 text-kitsuden-accent" />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center justify-between gap-x-3">
                      <h3 class="text-sm font-medium text-kitsuden-text">{n.title}</h3>
                      <span class="text-xs text-kitsuden-subtle">{formatDateTime(n.createdAt)}</span
                      >
                    </div>
                    <p class="mt-0.5 text-xs text-kitsuden-subtle">{n.message || ""}</p>
                    {#if n.documentId}
                      <Button
                        variant="ghost"
                        size="sm"
                        class="-ml-2 mt-1"
                        onclick={() =>
                          openDrawer({
                            id: n.documentId!,
                            code: "",
                            title: n.documentTitle || "",
                            slug: "",
                            type: "other",
                            status: "draft",
                            tags: [],
                            currentVersionNumber: 1,
                            updatedAt: "",
                          })}
                      >
                        {tr("dMSView.viewDocument")}
                      </Button>
                    {/if}
                  </div>
                  {#if !n.read}
                    <Button
                      variant="ghost"
                      size="icon"
                      ariaLabel={tr("dMSView.markRead")}
                      title={tr("dMSView.markRead")}
                      onclick={() => markNotificationRead(n.id)}
                    >
                      <Check class="w-4 h-4" />
                    </Button>
                  {/if}
                </div>
              </CardContent>
            </Card>
          {/each}
          {#if notifTotalPages > 1}
            <div class="flex justify-center">
              <Pagination
                bind:page={notifPage}
                pageCount={notifTotalPages}
                onchange={() => loadNotifications()}
              />
            </div>
          {/if}
        {/if}
      </div>
    {/if}

    {#if activeSection === "stats"}
      {#if stats}
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label={tr("dMSView.totalDocuments")} value={stats.documents?.total || 0} />
          <Stat
            label={tr("common.published")}
            value={stats.documents?.published || 0}
            variant="success"
          />
          <Stat label={tr("dMSView.drafts")} value={stats.documents?.draft || 0} />
          <Stat
            label={tr("dMSView.inReview")}
            value={stats.documents?.review_pending || 0}
            variant={stats.documents?.review_pending ? "warning" : "default"}
          />
          <Stat label={tr("common.archived")} value={stats.documents?.archived || 0} />
          <Stat
            label={tr("dMSView.upcomingReviews")}
            value={stats.upcomingReviews?.length || 0}
            variant={stats.upcomingReviews?.length ? "warning" : "default"}
          />
        </div>

        {#if stats.statusDistribution}
          <Card>
            <CardHeader>
              <CardTitle level={2}>{tr("dMSView.statusDistribution")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="flex flex-col gap-3">
                {#each Object.entries(stats.statusDistribution) as [status, count]}
                  <Progress
                    label={`${getStatusConfig(status).label} · ${count}`}
                    value={Number(count)}
                    max={stats.documents?.total || 1}
                    showValue
                  />
                {/each}
              </div>
            </CardContent>
          </Card>
        {/if}
      {:else}
        <div class="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      {/if}
    {/if}
  </div>

  <!-- Document detail -->
  <Sheet
    open={!!drawerOpen}
    size="2xl"
    title={drawerDoc?.title || tr("dMSView.document")}
    description={drawerDoc?.code || undefined}
    onClose={() => closeDrawer()}
  >
    {#if drawerOpen}
      {#if drawerLoading}
        <div class="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      {:else if !drawerDoc}
        <EmptyState size="sm" title={tr("dMSView.noDocumentSelected")} />
      {:else}
        <div class="flex min-w-0 flex-col gap-4">
          <div class="flex flex-wrap items-center gap-2">
            {#if drawerDoc.isTemplate}
              <Badge variant="purple">{tr("dMSView.template2")}</Badge>
            {/if}
            {#if drawerDoc.requiresReview || isOverdue(drawerDoc.reviewDueDate)}
              <Badge variant="error">{tr("dMSView.reviewOverdue2")}</Badge>
            {/if}
            <div class="ml-auto flex flex-wrap items-center gap-2">
              {#if drawerDoc.isTemplate}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => drawerDoc && cloneFromTemplate(drawerDoc.id)}
                >
                  <Copy class="w-3.5 h-3.5" />
                  {tr("dMSView.clone")}
                </Button>
              {/if}
              <Button variant="secondary" size="sm" onclick={() => exportVersion("md")}>
                <Download class="w-3.5 h-3.5" />
                {tr("dMSView.md")}
              </Button>
              <Button variant="secondary" size="sm" onclick={() => exportVersion("html")}>
                <FileCode class="w-3.5 h-3.5" />
                {tr("dMSView.html")}
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                onclick={() => {
                  if (drawerDoc) {
                    deleteTargetIds = [drawerDoc.id];
                    showConfirmDeleteModal = true;
                  }
                }}
              >
                <Trash2 class="w-3.5 h-3.5" />
                {tr("common.delete")}
              </Button>
            </div>
          </div>

          <Tabs
            items={drawerTabs}
            bind:value={drawerTab}
            panels={false}
            ariaLabel={tr("dMSView.documentSections")}
          />

          {#if drawerTab === "metadata"}
            <div class="flex max-w-2xl flex-col gap-4">
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={tr("common.title")}>
                  <Input id="title" value={formDoc.title ?? ""} oninput={setField("title")} />
                </Field>
                <Field label={tr("dMSView.code")}>
                  <Input
                    id="code"
                    class="font-mono"
                    value={formDoc.code ?? ""}
                    oninput={setField("code")}
                  />
                </Field>
                <Field label={tr("common.slug")}>
                  <Input id="slug" value={formDoc.slug ?? ""} oninput={setField("slug")} />
                </Field>
                <Field label={tr("common.type")}>
                  <Select
                    id="type"
                    value={formDoc.type ?? ""}
                    onchange={setField("type")}
                    options={documentTypes.map((d) => ({ value: d.id, label: d.label }))}
                  />
                </Field>
                <Field label={tr("common.status")}>
                  <Select
                    id="status"
                    value={formDoc.status ?? ""}
                    onchange={setField("status")}
                    options={workflowStatuses.map((s) => ({ value: s.id, label: s.label }))}
                  />
                </Field>
                <Field label={tr("common.category")}>
                  <Select
                    id="categoryid"
                    value={formDoc.categoryId ?? ""}
                    onchange={setField("categoryId")}
                    placeholder={tr("dMSView.none")}
                    options={categoryOptions}
                  />
                </Field>
                <Field label={tr("common.visibility")}>
                  <Select
                    id="visibility"
                    value={formDoc.visibility ?? ""}
                    onchange={setField("visibility")}
                    options={visibilityOptions.map((v) => ({ value: v.id, label: v.label }))}
                  />
                </Field>
                <Field label={tr("dMSView.effectiveDate")}>
                  <Input
                    id="effectivedate"
                    type="date"
                    value={formDoc.effectiveDate ?? ""}
                    oninput={setField("effectiveDate")}
                  />
                </Field>
                <Field
                  label={tr("dMSView.reviewDueDate")}
                  error={isOverdue(formDoc.reviewDueDate) ? tr("dMSView.reviewOverdue") : undefined}
                >
                  <Input
                    id="reviewduedate"
                    type="date"
                    value={formDoc.reviewDueDate ?? ""}
                    oninput={setField("reviewDueDate")}
                  />
                </Field>
                <Field label={tr("dMSView.expirationDate")}>
                  <Input
                    id="expirationdate"
                    type="date"
                    value={formDoc.expirationDate ?? ""}
                    oninput={setField("expirationDate")}
                  />
                </Field>
                <Checkbox
                  id="reqAck"
                  label={tr("dMSView.requiresAcknowledgment")}
                  checked={!!formDoc.requiresAcknowledgment}
                  onchange={(e: Event) =>
                    (formDoc.requiresAcknowledgment = (
                      e.currentTarget as HTMLInputElement
                    ).checked)}
                />
              </div>
              <Field label={tr("common.description")}>
                <Textarea
                  id="description"
                  rows={3}
                  value={formDoc.description ?? ""}
                  oninput={setField("description")}
                />
              </Field>
              <Field label={tr("dMSView.tagsCommaSeparated")}>
                <Input
                  id="tags-comma-separated"
                  value={Array.isArray(formDoc.tags) ? formDoc.tags.join(", ") : ""}
                  oninput={setList("tags")}
                />
              </Field>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={tr("dMSView.allowedUserIdsCommaSeparated")}>
                  <Input
                    value={Array.isArray(formDoc.allowedUserIds)
                      ? formDoc.allowedUserIds.join(", ")
                      : ""}
                    oninput={setList("allowedUserIds")}
                  />
                </Field>
                <Field label={tr("dMSView.allowedRoleIdsCommaSeparated")}>
                  <Input
                    value={Array.isArray(formDoc.allowedRoleIds)
                      ? formDoc.allowedRoleIds.join(", ")
                      : ""}
                    oninput={setList("allowedRoleIds")}
                  />
                </Field>
              </div>
              <div class="flex flex-wrap items-center gap-3 border-t border-kitsuden-border pt-4">
                <Button onclick={updateDocument} loading={saving} disabled={saving}>
                  <Save class="w-4 h-4" />
                  {saving ? tr("common.saving") : tr("dMSView.saveChanges")}
                </Button>
                <Button variant="secondary" onclick={closeDrawer}>{tr("dMSView.close")}</Button>
              </div>
            </div>
          {:else if drawerTab === "content"}
            <div class="flex min-w-0 flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <Select
                  width="auto"
                  aria-label={tr("dMSView.contentFormat")}
                  bind:value={contentFormat}
                  options={[
                    { value: "markdown", label: tr("common.markdown") },
                    { value: "html", label: tr("dMSView.html") },
                  ]}
                />
                <Button variant="secondary" size="sm" onclick={insertDiagramPlaceholder}>
                  <Layers class="w-3.5 h-3.5" />
                  {tr("dMSView.insertDiagram")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => {
                    contentEditor += "[[";
                  }}
                >
                  <Link2 class="w-3.5 h-3.5" />
                  {tr("dMSView.wikiLink")}
                </Button>
                <Button
                  class="ml-auto"
                  size="sm"
                  onclick={saveVersionContent}
                  loading={saving}
                  disabled={saving}
                >
                  {tr("dMSView.saveContent")}
                </Button>
              </div>
              <div class="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
                <div class="relative min-w-0">
                  <Textarea
                    id="content-editor"
                    mono
                    rows={18}
                    aria-label={tr("common.content")}
                    bind:value={contentEditor}
                    oninput={onContentInput}
                    placeholder={tr("dMSView.writeYourContentHere")}
                  />
                  {#if showWikiDropdown && wikiSuggestions.length > 0}
                    <div
                      class="absolute bottom-4 left-4 z-10 flex max-h-48 w-64 max-w-[calc(100%-2rem)] flex-col overflow-y-auto rounded-xl border border-kitsuden-border bg-kitsuden-card shadow-xl"
                    >
                      {#each wikiSuggestions as s}
                        <Button
                          variant="ghost"
                          class="w-full justify-start"
                          onclick={() => insertWikiLink(s)}
                        >
                          <span class="font-mono text-xs text-kitsuden-subtle">{s.code}</span>
                          <span class="truncate">{s.title}</span>
                        </Button>
                      {/each}
                    </div>
                  {/if}
                </div>
                <Card class="min-w-0">
                  <CardContent>
                    <div class="mb-2 flex items-center gap-1 text-xs text-kitsuden-subtle">
                      <Eye class="w-3 h-3" />
                      {tr("common.preview")}
                    </div>
                    {#if renderedHtml}
                      <div class="prose prose-invert prose-sm max-w-none overflow-auto">
                        {@html cleanHtml(renderedHtml)}
                      </div>
                    {:else}
                      <p class="text-sm text-kitsuden-subtle">
                        {tr("dMSView.previewWillAppearHereAfter")}
                      </p>
                    {/if}
                  </CardContent>
                </Card>
              </div>
              <div class="flex flex-wrap items-center gap-2 border-t border-kitsuden-border pt-3">
                <Input
                  class="min-w-0 flex-1 basis-48"
                  aria-label={tr("dMSView.changelog")}
                  placeholder={tr("dMSView.changelogForThisEdit")}
                  bind:value={changelogInput}
                />
                <Select
                  width="auto"
                  aria-label={tr("dMSView.changeType")}
                  bind:value={changeTypeInput}
                  options={changeTypeOptions}
                />
                <Button
                  size="sm"
                  onclick={createNewVersion}
                  disabled={saving || !changelogInput.trim()}
                >
                  <GitCommit class="w-3.5 h-3.5" />
                  {tr("dMSView.newVersion")}
                </Button>
              </div>
            </div>
          {:else if drawerTab === "versions"}
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.versionHistory")}</h3>
                <Button size="sm" onclick={() => (showCreateVersionModal = true)}>
                  <Plus class="w-3.5 h-3.5" />
                  {tr("dMSView.createVersion")}
                </Button>
              </div>
              {#if versions.length === 0}
                <EmptyState size="sm" title={tr("dMSView.noVersionsYet")} />
              {:else}
                {#each versions as v}
                  <Card>
                    <CardContent>
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                          <GitCommit class="w-4 h-4 text-kitsuden-accent" />
                          <span class="font-mono text-sm text-kitsuden-text"
                            >v{v.versionNumber}</span
                          >
                          <Badge variant={statusVariant(v.status)}
                            >{getStatusConfig(v.status).label}</Badge
                          >
                        </div>
                        <span class="text-xs text-kitsuden-subtle"
                          >{formatDateTime(v.createdAt)}</span
                        >
                      </div>
                      <p class="mt-1 text-xs text-kitsuden-subtle">
                        {v.changelog || tr("dMSView.noChangelog")}
                      </p>
                      <p class="text-xs text-kitsuden-text-dim">
                        {tr("dMSView.by")}
                        {v.createdBy?.name || tr("dMSView.unknown")}
                      </p>
                      <div class="mt-2 flex flex-wrap items-center gap-2">
                        {#if v.status === "draft"}
                          <Button
                            variant="secondary"
                            size="sm"
                            onclick={() => submitForReview(v.id)}
                          >
                            <Send class="w-3 h-3" />
                            {tr("dMSView.submitForReview")}
                          </Button>
                        {:else if v.status === "review_pending"}
                          <Button size="sm" onclick={() => reviewVersion(v.id, "approved")}>
                            <Check class="w-3 h-3" />
                            {tr("dMSView.approve")}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onclick={() => reviewVersion(v.id, "changes_requested")}
                          >
                            <XCircle class="w-3 h-3" />
                            {tr("dMSView.requestChanges")}
                          </Button>
                          <Input
                            class="min-w-0 flex-1 basis-40"
                            aria-label={tr("dMSView.reviewNotes")}
                            placeholder={tr("dMSView.reviewNotes")}
                            bind:value={reviewNotes}
                          />
                        {:else if v.status === "approved"}
                          <Button size="sm" onclick={() => publishVersion(v.id)}>
                            <CheckCircle class="w-3 h-3" />
                            {tr("dMSView.publish")}
                          </Button>
                        {:else if v.status === "published"}
                          <Badge variant="info" dot>{tr("common.published")}</Badge>
                        {/if}
                      </div>
                    </CardContent>
                  </Card>
                {/each}
              {/if}
            </div>
          {:else if drawerTab === "comments"}
            <div class="flex flex-col gap-3">
              <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.comments")}</h3>
              <div class="flex gap-3">
                <Avatar name={tr("dMSView.you")} size="sm" decorative />
                <div class="min-w-0 flex-1">
                  {#if replyToId}
                    <div class="mb-1 flex items-center gap-2">
                      <span class="text-xs text-kitsuden-accent"
                        >{tr("dMSView.replyingToComment")}</span
                      >
                      <Button variant="ghost" size="sm" onclick={() => (replyToId = null)}
                        >{tr("common.cancel")}</Button
                      >
                    </div>
                  {/if}
                  <Textarea
                    rows={2}
                    aria-label={tr("dMSView.addAComment")}
                    placeholder={tr("dMSView.addAComment")}
                    bind:value={commentInput}
                  />
                  <div class="mt-2 flex justify-end">
                    <Button size="sm" onclick={postComment} disabled={!commentInput.trim()}>
                      <Send class="w-3 h-3" />
                      {tr("dMSView.post")}
                    </Button>
                  </div>
                </div>
              </div>
              {#each comments.filter((c) => !c.parentId) as comment}
                <Card>
                  <CardContent>
                    <div class="flex items-start gap-3">
                      <Avatar
                        name={comment.createdBy?.name || tr("dMSView.unknown")}
                        size="sm"
                        decorative
                      />
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center justify-between gap-x-3">
                          <span class="text-sm font-medium text-kitsuden-text"
                            >{comment.createdBy?.name || tr("dMSView.unknown")}</span
                          >
                          <span class="text-xs text-kitsuden-subtle"
                            >{formatDateTime(comment.createdAt)}</span
                          >
                        </div>
                        <p class="mt-1 text-sm text-kitsuden-subtle">{comment.content}</p>
                        <div class="mt-2 flex flex-wrap items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onclick={() => (replyToId = comment.id)}
                          >
                            <Reply class="w-3 h-3" />
                            {tr("dMSView.reply")}
                          </Button>
                          {#if !comment.resolved}
                            <Button
                              variant="ghost"
                              size="sm"
                              onclick={() => resolveComment(comment.id)}
                            >
                              <Check class="w-3 h-3" />
                              {tr("dMSView.resolve")}
                            </Button>
                          {:else}
                            <Badge variant="success" dot>{tr("dMSView.resolved")}</Badge>
                          {/if}
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            onclick={() => deleteComment(comment.id)}
                          >
                            <Trash2 class="w-3 h-3" />
                            {tr("common.delete")}
                          </Button>
                        </div>
                        {#if comment.replies && comment.replies.length > 0}
                          <div
                            class="mt-3 ml-2 flex flex-col gap-2 border-l border-kitsuden-border pl-3"
                          >
                            {#each comment.replies as reply}
                              <div class="flex items-start gap-2">
                                <Avatar
                                  name={reply.createdBy?.name || tr("dMSView.unknown")}
                                  size="sm"
                                  decorative
                                />
                                <div class="min-w-0 flex-1">
                                  <div class="flex flex-wrap items-center gap-x-2">
                                    <span class="text-xs font-medium text-kitsuden-text"
                                      >{reply.createdBy?.name || tr("dMSView.unknown")}</span
                                    >
                                    <span class="text-xs text-kitsuden-subtle"
                                      >{formatDateTime(reply.createdAt)}</span
                                    >
                                  </div>
                                  <p class="mt-0.5 text-xs text-kitsuden-subtle">{reply.content}</p>
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              {/each}
              {#if comments.length === 0}
                <EmptyState size="sm" title={tr("dMSView.noCommentsYet")} />
              {/if}
            </div>
          {:else if drawerTab === "diagrams"}
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.diagrams")}</h3>
                <Button size="sm" onclick={() => (showCreateDiagramModal = true)}>
                  <Plus class="w-3.5 h-3.5" />
                  {tr("dMSView.addDiagram")}
                </Button>
              </div>
              {#if diagrams.length === 0}
                <EmptyState size="sm" title={tr("dMSView.noDiagramsForThisVersion")} />
              {:else}
                {#each diagrams as d}
                  <Card>
                    <CardContent>
                      <div class="mb-2 flex items-center justify-between gap-2">
                        <h4 class="min-w-0 truncate text-sm font-medium text-kitsuden-text">
                          {d.name}
                        </h4>
                        <Button
                          variant="danger-ghost"
                          size="icon"
                          ariaLabel={tr("dMSView.deleteDiagram", { name: d.name })}
                          title={tr("common.delete")}
                          onclick={() => deleteDiagram(d.id)}
                        >
                          <Trash2 class="w-4 h-4" />
                        </Button>
                      </div>
                      {#if d.renderedSvg}
                        <div class="overflow-auto rounded-lg bg-white p-2">
                          {@html cleanSvg(d.renderedSvg)}
                        </div>
                      {:else if d.sourceXml}
                        <pre
                          class="max-h-40 overflow-auto rounded-lg bg-kitsuden-bg p-3 text-xs text-kitsuden-subtle">{d.sourceXml.slice(
                            0,
                            500
                          )}{d.sourceXml.length > 500 ? "..." : ""}</pre>
                      {:else}
                        <p class="text-xs text-kitsuden-subtle">
                          {tr("dMSView.noPreviewAvailable")}
                        </p>
                      {/if}
                    </CardContent>
                  </Card>
                {/each}
              {/if}
            </div>
          {:else if drawerTab === "audit"}
            <div class="flex flex-col gap-3">
              <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.auditLog")}</h3>
              {#if auditEntries.length === 0}
                <EmptyState size="sm" title={tr("dMSView.noAuditEntries")} />
              {:else}
                {#each auditEntries as entry}
                  <Card>
                    <CardContent>
                      <div class="flex flex-wrap items-center justify-between gap-x-3">
                        <span class="text-sm font-medium text-kitsuden-text">{entry.action}</span>
                        <span class="text-xs text-kitsuden-subtle"
                          >{formatDateTime(entry.createdAt)}</span
                        >
                      </div>
                      <p class="mt-1 text-xs text-kitsuden-subtle">
                        {tr("dMSView.by")}
                        {entry.user?.name || tr("common.system")}
                      </p>
                      {#if entry.details}
                        <pre
                          class="mt-2 overflow-auto rounded-sm bg-kitsuden-bg p-2 text-xs text-kitsuden-text-dim">{JSON.stringify(
                            entry.details,
                            null,
                            2
                          )}</pre>
                      {/if}
                    </CardContent>
                  </Card>
                {/each}
              {/if}
            </div>
          {:else if drawerTab === "backlinks"}
            <div class="flex flex-col gap-3">
              <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.backlinks")}</h3>
              <p class="text-sm text-kitsuden-subtle">{tr("dMSView.documentsThatLinkToThis")}</p>
              {#if backlinks.length === 0}
                <EmptyState size="sm" title={tr("dMSView.noBacklinksFound")} />
              {:else}
                {#each backlinks as bl}
                  <Button
                    variant="secondary"
                    class="w-full justify-start"
                    onclick={() =>
                      openDrawer({
                        id: bl.id,
                        code: bl.code,
                        title: bl.title,
                        slug: "",
                        type: "other",
                        status: "draft",
                        tags: [],
                        currentVersionNumber: 1,
                        updatedAt: "",
                      })}
                  >
                    <Link2 class="w-4 h-4 shrink-0 text-kitsuden-accent" />
                    <span class="truncate">{bl.title}</span>
                    <span class="ml-auto font-mono text-xs text-kitsuden-subtle">{bl.code}</span>
                  </Button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </Sheet>

  <!-- New document -->
  <Dialog
    open={!!showCreateDocModal}
    size="2xl"
    title={tr("dMSView.newDocument")}
    onClose={() => (showCreateDocModal = false)}
  >
    <form id="{uid}-doc" onsubmit={createDocument} class="flex flex-col gap-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={tr("common.title")} required>
          <Input
            id="title-2"
            value={formDoc.title ?? ""}
            oninput={setField("title")}
            placeholder={tr("dMSView.documentTitle")}
            required
          />
        </Field>
        <Field label={tr("common.type")}>
          <Select
            id="type-2"
            value={formDoc.type ?? ""}
            onchange={setField("type")}
            options={documentTypes.map((d) => ({ value: d.id, label: d.label }))}
          />
        </Field>
      </div>
      <Field label={tr("common.description")}>
        <Textarea
          id="description-2"
          rows={3}
          value={formDoc.description ?? ""}
          oninput={setField("description")}
          placeholder={tr("dMSView.shortDescription")}
        />
      </Field>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={tr("common.status")}>
          <Select
            id="status-2"
            value={formDoc.status ?? ""}
            onchange={setField("status")}
            options={workflowStatuses.map((s) => ({ value: s.id, label: s.label }))}
          />
        </Field>
        <Field label={tr("common.category")}>
          <Select
            id="categoryid-2"
            value={formDoc.categoryId ?? ""}
            onchange={setField("categoryId")}
            placeholder={tr("dMSView.noCategory")}
            options={categoryOptions}
          />
        </Field>
        <Field label={tr("common.visibility")}>
          <Select
            id="visibility-2"
            value={formDoc.visibility ?? ""}
            onchange={setField("visibility")}
            options={visibilityOptions.map((v) => ({ value: v.id, label: v.label }))}
          />
        </Field>
        <Field label={tr("dMSView.tagsCommaSeparated")}>
          <Input
            id="tags-comma-separated-2"
            placeholder={tr("dMSView.policyHr2025")}
            oninput={setList("tags")}
          />
        </Field>
      </div>
    </form>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showCreateDocModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button type="submit" form="{uid}-doc" loading={saving} disabled={saving || !formDoc.title}>
        <Plus class="w-4 h-4" />
        {saving ? tr("common.creating") : tr("dMSView.createDocument")}
      </Button>
    {/snippet}
  </Dialog>

  <!-- New category -->
  <Dialog
    open={!!showCreateCatModal}
    size="lg"
    title={tr("dMSView.newCategory")}
    onClose={() => (showCreateCatModal = false)}
  >
    <form id="{uid}-cat" onsubmit={saveCategory} class="flex flex-col gap-4">
      <Field label={tr("common.name2")} required>
        <Input
          id="newcategoryname"
          bind:value={newCategoryName}
          placeholder={tr("dMSView.categoryName")}
          required
        />
      </Field>
      <Field label={tr("common.description")}>
        <Textarea
          id="newcategorydescription"
          rows={2}
          bind:value={newCategoryDescription}
          placeholder={tr("dMSView.shortDescription")}
        />
      </Field>
      <div class="grid grid-cols-2 gap-4">
        <Field label={tr("dMSView.icon")}>
          <Input id="newcategoryicon" bind:value={newCategoryIcon} placeholder="📁" />
        </Field>
        <Field label={tr("dMSView.color")}>
          <input
            id="newcategorycolor"
            bind:value={newCategoryColor}
            type="color"
            class="h-10 w-full rounded-lg border border-kitsuden-input bg-kitsuden-bg px-2 py-1"
          />
        </Field>
      </div>
      <Field label={tr("dMSView.parentCategory")}>
        <Select
          id="newcategoryparentid"
          bind:value={newCategoryParentId}
          placeholder={tr("dMSView.noneRoot")}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Field>
    </form>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showCreateCatModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button type="submit" form="{uid}-cat" loading={saving} disabled={saving || !newCategoryName}>
        <Plus class="w-4 h-4" />
        {saving ? tr("common.creating") : tr("dMSView.createCategory")}
      </Button>
    {/snippet}
  </Dialog>

  <!-- Confirm deletion -->
  <Dialog
    open={!!showConfirmDeleteModal}
    title={deleteTargetIds.length === 1
      ? tr("list.deleteOneTitle", {
          name:
            documents.find((d) => d.id === deleteTargetIds[0])?.title ??
            tr("dMSView.deleteOneFallback"),
        })
      : tr("dMSView.deleteManyTitle", { n: deleteTargetIds.length })}
    description={tr("list.deleteDescription")}
    size="sm"
    onClose={() => (showConfirmDeleteModal = false)}
  >
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showConfirmDeleteModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button variant="danger" onclick={() => deleteDocuments(deleteTargetIds)}>
        <Trash2 class="w-4 h-4" />
        {tr("common.delete")}
      </Button>
    {/snippet}
  </Dialog>

  <!-- New version -->
  <Dialog
    open={!!showCreateVersionModal}
    size="lg"
    title={tr("dMSView.createNewVersion")}
    onClose={() => (showCreateVersionModal = false)}
  >
    <div class="flex flex-col gap-4">
      <Field label={tr("dMSView.changeType")}>
        <Select id="changetypeinput" bind:value={changeTypeInput} options={changeTypeOptions} />
      </Field>
      <Field label={tr("dMSView.changelog")}>
        <Textarea
          id="changeloginput"
          rows={3}
          placeholder={tr("dMSView.describeWhatChanged")}
          bind:value={changelogInput}
        />
      </Field>
    </div>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showCreateVersionModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button
        onclick={createNewVersion}
        loading={saving}
        disabled={saving || !changelogInput.trim()}
      >
        {tr("dMSView.createVersion")}
      </Button>
    {/snippet}
  </Dialog>

  <!-- New diagram -->
  <Dialog
    open={!!showCreateDiagramModal}
    size="lg"
    title={tr("dMSView.addDiagram")}
    onClose={() => (showCreateDiagramModal = false)}
  >
    <form id="{uid}-diagram" onsubmit={createDiagram} class="flex flex-col gap-4">
      <Field label={tr("common.name")} required>
        <Input
          id="newdiagramname"
          bind:value={newDiagramName}
          placeholder={tr("dMSView.diagramName")}
          required
        />
      </Field>
      <Field label={tr("dMSView.sourceXmlJson")}>
        <Textarea
          id="newdiagramsource"
          rows={6}
          mono
          bind:value={newDiagramSource}
          placeholder={tr("dMSView.pasteDiagramSourceXmlOr")}
        />
      </Field>
    </form>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showCreateDiagramModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button
        type="submit"
        form="{uid}-diagram"
        loading={saving}
        disabled={saving || !newDiagramName}
      >
        {tr("dMSView.addDiagram")}
      </Button>
    {/snippet}
  </Dialog>
</ViewPage>

<style>
  /* The title wraps and opens the document; the other values keep one line. */
  :global(.dms-docs .ta-table-td) {
    white-space: nowrap;
  }
  :global(.dms-docs .ta-table-td:has(.dms-doc-link)),
  :global(.dms-docs .ta-table-td.dms-wrap) {
    white-space: normal;
  }
  :global(.dms-docs .ta-table-td.dms-wrap) {
    min-width: 7rem;
  }
  .dms-doc-link {
    padding: 0;
    font: inherit;
    font-weight: 500;
    text-align: left;
    color: rgb(var(--ta-text));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .dms-doc-link:hover {
    text-decoration: underline;
    text-decoration-color: rgb(var(--ta-accent));
    text-underline-offset: 3px;
  }
  .dms-doc-link:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }
  /* The row menu is pinned to the right edge while the table scrolls sideways (a phone). */
  :global(.dms-docs .dms-pin) {
    position: sticky;
    right: 0;
    z-index: 1;
    width: 1%;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    text-align: right;
    background: rgb(var(--ta-bg));
    box-shadow: inset 1px 0 0 rgb(var(--ta-border));
  }
  :global(.dms-docs thead .dms-pin) {
    background:
      linear-gradient(rgb(var(--ta-elevated) / 0.4), rgb(var(--ta-elevated) / 0.4)),
      rgb(var(--ta-bg));
  }
  :global(.dms-docs tbody tr:hover > .dms-pin) {
    background:
      linear-gradient(rgb(var(--ta-elevated) / 0.35), rgb(var(--ta-elevated) / 0.35)),
      rgb(var(--ta-bg));
  }
  :global(.dms-docs .dms-row-menu) {
    width: 1.75rem;
    height: 1.75rem;
    min-height: 0;
  }
  @media (pointer: coarse) {
    :global(.dms-docs .dms-row-menu) {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
