<script lang="ts">
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
    GitBranch,
    Activity,
    Plus,
    Search,
    Eye,
    Edit2,
    Trash2,
    CheckCircle,
    Clock,
    XCircle,
    AlertCircle,
    ChevronRight,
    ChevronDown,
    Download,
    FileStack,
    ClipboardCheck,
    Archive,
    Settings,
    X,
    ChevronLeft,
    ChevronLast,
    ChevronFirst,
    Save,
    Send,
    Check,
    MessageSquare,
    GitCommit,
    Bell,
    BarChart3,
    Layers,
    Link2,
    FileCode,
    Sparkles,
    Loader2,
    Inbox,
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

  interface Toast {
    id: number;
    message: string;
    type: "success" | "error" | "info";
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

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  // Global
  let activeSection = $state<"documents" | "categories" | "templates" | "notifications" | "stats">(
    "documents"
  );
  let loading = $state(true);
  let saving = $state(false);
  let toasts = $state<Toast[]>([]);

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
  let drawerTab = $state<
    "metadata" | "content" | "versions" | "comments" | "diagrams" | "audit" | "backlinks"
  >("metadata");
  let drawerLoading = $state(false);

  // Drawer sub-state
  let versions = $state<Version[]>([]);
  let comments = $state<Comment[]>([]);
  let diagrams = $state<Diagram[]>([]);
  let auditEntries = $state<AuditEntry[]>([]);
  let backlinks = $state<Backlink[]>([]);
  let renderedHtml = $state("");
  let contentEditor = $state("");
  let contentFormat = $state<"markdown" | "html">("markdown");
  let commentInput = $state("");
  let replyToId = $state<string | null>(null);
  let wikiQuery = $state("");
  let wikiSuggestions = $state<Doc[]>([]);
  let showWikiDropdown = $state(false);
  let wikiCaretPos = $state(0);
  let changelogInput = $state("");
  let changeTypeInput = $state<"major" | "minor" | "patch">("minor");
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

  function showToast(message: string, type: Toast["type"] = "info") {
    const id = Date.now() + Math.random();
    toasts = [...toasts, { id, message, type }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 4000);
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
      renderedHtml = '<p class="text-kitsuden-subtle">Preview not available</p>';
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
      showToast(`${ids.length} document(s) deleted`, "success");
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

  function getInitials(name?: string) {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }

  function statusBadgeClass(status?: string) {
    switch (status) {
      case "published":
        return "bg-blue-500/10 text-blue-500";
      case "approved":
        return "bg-green-500/10 text-green-500";
      case "review_pending":
        return "bg-yellow-500/10 text-yellow-500";
      case "draft":
        return "bg-gray-500/10 text-gray-400";
      case "archived":
        return "bg-purple-500/10 text-purple-500";
      case "deprecated":
        return "bg-red-500/10 text-red-500";
      case "changes_requested":
        return "bg-orange-500/10 text-orange-500";
      default:
        return "bg-gray-500/10 text-gray-400";
    }
  }

  function sectionLabel(section: string) {
    switch (section) {
      case "documents":
        return "Documents";
      case "categories":
        return "Categories";
      case "templates":
        return "Templates";
      case "notifications":
        return "Notifications";
      case "stats":
        return "Stats";
      default:
        return "Documents";
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

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- HEADER -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<div class="h-full flex flex-col bg-kitsuden-bg">
  <div class="border-b border-kitsuden-border bg-kitsuden-card px-6 py-4 shrink-0">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-orange-500 to-amber-500 flex items-center justify-center"
        >
          <FileStack class="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 class="text-xl font-bold text-kitsuden-text">{tr("dMSView.documentManagement")}</h1>
          <p class="text-sm text-kitsuden-subtle">
            {tr("dMSView.versionedDocumentStorageWithApproval")}
          </p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        {#if activeSection === "documents" || activeSection === "templates"}
          <button class="btn-secondary" onclick={() => (showCreateCatModal = true)}>
            <FolderTree class="w-4 h-4" />
            {tr("dMSView.categories")}
          </button>
          <button class="btn-primary" onclick={openCreateDocumentModal}>
            <Plus class="w-4 h-4" />
            {tr("dMSView.newDocument")}
          </button>
        {/if}
        {#if activeSection === "categories"}
          <button class="btn-primary" onclick={() => (showCreateCatModal = true)}>
            <Plus class="w-4 h-4" />
            {tr("dMSView.newCategory")}
          </button>
        {/if}
      </div>
    </div>

    <!-- Section Tabs -->
    <div class="flex items-center gap-1 mt-4 border-t border-kitsuden-border pt-3">
      {#each ["documents", "categories", "templates", "notifications", "stats"] as const as sec}
        <button
          class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 {activeSection ===
          sec
            ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
            : 'text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-bg'}"
          onclick={() => {
            activeSection = sec;
            selectedIds = new Set();
          }}
        >
          {#if sec === "documents"}<FileText class="w-4 h-4" />{/if}
          {#if sec === "categories"}<FolderTree class="w-4 h-4" />{/if}
          {#if sec === "templates"}<Copy class="w-4 h-4" />{/if}
          {#if sec === "notifications"}
            <Bell class="w-4 h-4" />
            {#if unreadCount > 0}
              <span
                class="ml-0.5 px-1.5 py-0.5 rounded-full bg-kitsuden-accent-2 text-white text-[10px] leading-none"
                >{unreadCount}</span
              >
            {/if}
          {/if}
          {#if sec === "stats"}<BarChart3 class="w-4 h-4" />{/if}
          {sectionLabel(sec)}
        </button>
      {/each}
    </div>

    <!-- Stats Row (visible on documents/templates tabs) -->
    {#if stats && (activeSection === "documents" || activeSection === "templates")}
      <div class="grid grid-cols-5 gap-4 mt-3 pt-3 border-t border-kitsuden-border">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <FileText class="w-4 h-4 text-blue-500" />
          </div>
          <div>
            <p class="text-lg font-bold text-kitsuden-text">{stats.documents?.total || 0}</p>
            <p class="text-[11px] text-kitsuden-subtle">{tr("dMSView.totalDocuments")}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
            <CheckCircle class="w-4 h-4 text-green-500" />
          </div>
          <div>
            <p class="text-lg font-bold text-kitsuden-text">{stats.documents?.published || 0}</p>
            <p class="text-[11px] text-kitsuden-subtle">{tr("common.published")}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-yellow-500/10 flex items-center justify-center">
            <Clock class="w-4 h-4 text-yellow-500" />
          </div>
          <div>
            <p class="text-lg font-bold text-kitsuden-text">{stats.documents?.draft || 0}</p>
            <p class="text-[11px] text-kitsuden-subtle">{tr("dMSView.drafts")}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center">
            <AlertCircle class="w-4 h-4 text-purple-500" />
          </div>
          <div>
            <p class="text-lg font-bold text-kitsuden-text">
              {stats.upcomingReviews?.length || 0}
            </p>
            <p class="text-[11px] text-kitsuden-subtle">{tr("dMSView.upForReview")}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center">
            <Inbox class="w-4 h-4 text-kitsuden-accent" />
          </div>
          <div>
            <p class="text-lg font-bold text-kitsuden-text">
              {stats.pendingApprovals || unreadCount || 0}
            </p>
            <p class="text-[11px] text-kitsuden-subtle">{tr("dMSView.pending")}</p>
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- ═════════════════════════════════════════════════════════════════════════ -->
  <!-- MAIN CONTENT -->
  <!-- ═════════════════════════════════════════════════════════════════════════ -->
  <div class="flex-1 flex overflow-hidden">
    <!-- ───────────────────────────── Sidebar (Categories) ───────────────────────────── -->
    {#if activeSection === "documents" || activeSection === "templates"}
      <div class="w-64 border-r border-kitsuden-border bg-kitsuden-card flex flex-col shrink-0">
        <div class="p-4 border-b border-kitsuden-border">
          <h3 class="font-semibold text-kitsuden-text flex items-center gap-2 text-sm">
            <FolderTree class="w-4 h-4" />
            {tr("dMSView.categories")}
          </h3>
        </div>
        <div class="flex-1 overflow-y-auto p-2">
          <button
            class="w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 {selectedCategory ===
            null
              ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
              : 'text-kitsuden-text hover:bg-kitsuden-bg'}"
            onclick={() => selectCategory(null)}
          >
            <FileText class="w-4 h-4" />
            {tr("dMSView.allDocuments")}
          </button>
          {#each categories as category}
            <div class="mt-1">
              <div class="group flex items-center gap-1">
                {#if category.children && category.children.length > 0}
                  <button
                    class="p-1 hover:bg-kitsuden-bg rounded-sm shrink-0"
                    onclick={() => toggleCategory(category)}
                  >
                    {#if expandedCategories.has(category.id)}
                      <ChevronDown class="w-3.5 h-3.5 text-kitsuden-text-dim" />
                    {:else}
                      <ChevronRight class="w-3.5 h-3.5 text-kitsuden-text-dim" />
                    {/if}
                  </button>
                {:else}
                  <span class="w-6 shrink-0"></span>
                {/if}
                <button
                  class="flex-1 text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 {selectedCategory?.id ===
                  category.id
                    ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
                    : 'text-kitsuden-text hover:bg-kitsuden-bg'}"
                  onclick={() => selectCategory(category)}
                >
                  <span class="text-lg shrink-0">{category.icon || "📁"}</span>
                  <span class="truncate">{category.name}</span>
                  <span class="ml-auto text-xs text-kitsuden-subtle shrink-0"
                    >{category.documentCount || 0}</span
                  >
                </button>
              </div>
              {#if expandedCategories.has(category.id) && category.children && category.children.length > 0}
                <div class="ml-4 pl-2 border-l border-kitsuden-border">
                  {#each category.children as child}
                    <button
                      class="w-full text-left px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 mt-0.5 {selectedCategory?.id ===
                      child.id
                        ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
                        : 'text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-bg'}"
                      onclick={() => selectCategory(child)}
                    >
                      <span class="text-sm">{child.icon || "📂"}</span>
                      <span class="truncate">{child.name}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ───────────────────────────── Content Area ───────────────────────────── -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      {#if activeSection === "documents" || activeSection === "templates"}
        <!-- Filters Bar -->
        <div class="p-4 border-b border-kitsuden-border bg-kitsuden-card shrink-0">
          <div class="flex items-center gap-3 flex-wrap">
            <div class="relative flex-1 min-w-[200px] max-w-md">
              <Search
                class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-text-dim"
              />
              <input
                type="text"
                placeholder={tr("dMSView.searchDocuments")}
                class="w-full pl-10 pr-4 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-text-dim focus:outline-hidden focus:border-kitsuden-accent/50"
                bind:value={searchQuery}
                oninput={() => {
                  currentPage = 1;
                  loadDocuments();
                }}
              />
            </div>
            <select
              class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent/50"
              bind:value={statusFilter}
              onchange={() => {
                currentPage = 1;
                loadDocuments();
              }}
            >
              <option value="">{tr("dMSView.allStatus")}</option>
              {#each workflowStatuses as s}
                <option value={s.id}>{s.label}</option>
              {/each}
            </select>
            <select
              class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent/50"
              bind:value={typeFilter}
              onchange={() => {
                currentPage = 1;
                loadDocuments();
              }}
            >
              <option value="">{tr("dMSView.allTypes")}</option>
              {#each documentTypes as t}
                <option value={t.id}>{t.label}</option>
              {/each}
            </select>
            {#if selectedIds.size > 0}
              <div class="flex items-center gap-2 ml-auto">
                <span class="text-xs text-kitsuden-subtle"
                  >{selectedIds.size} {tr("common.selected")}</span
                >
                <button class="btn-danger btn-sm" onclick={promptBulkDelete}>
                  <Trash2 class="w-3.5 h-3.5" />
                  {tr("common.delete")}
                </button>
              </div>
            {/if}
          </div>
        </div>

        <!-- Document Table -->
        <div class="flex-1 overflow-auto">
          {#if loading}
            <div class="flex items-center justify-center h-full">
              <div
                class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
              ></div>
            </div>
          {:else if filteredDocuments.length === 0}
            <div class="flex flex-col items-center justify-center h-full text-center">
              <div
                class="w-16 h-16 rounded-full bg-kitsuden-bg flex items-center justify-center mb-4"
              >
                <FileText class="w-8 h-8 text-kitsuden-text-dim" />
              </div>
              <h3 class="text-lg font-semibold text-kitsuden-text mb-1">
                {tr("dMSView.noDocumentsFound")}
              </h3>
              <p class="text-sm text-kitsuden-subtle">
                {selectedCategory
                  ? tr("dMSView.thisCategoryIsEmpty")
                  : tr("dMSView.getStartedByCreatingYour")}
              </p>
            </div>
          {:else}
            <table class="w-full text-left text-sm">
              <thead class="bg-kitsuden-bg sticky top-0 z-10">
                <tr class="border-b border-kitsuden-border">
                  <th class="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      class="rounded-sm border-kitsuden-border bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent/30"
                      checked={allSelected}
                      indeterminate={someSelected}
                      onchange={toggleSelectAll}
                    />
                  </th>
                  {#each sortableColumns as col}
                    <th
                      class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none hover:text-kitsuden-text"
                      onclick={() => toggleSort(col.key)}
                    >
                      <div class="flex items-center gap-1">
                        {col.label}
                        {#if sortKey === col.key}
                          <span class="text-kitsuden-accent">{sortDir === "asc" ? "▲" : "▼"}</span>
                        {/if}
                      </div>
                    </th>
                  {/each}
                  <th class="px-4 py-3 font-medium text-kitsuden-subtle">{tr("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {#each filteredDocuments as doc}
                  {@const status = getStatusConfig(doc.status)}
                  {@const type = getTypeConfig(doc.type)}
                  <tr
                    class="border-b border-kitsuden-border hover:bg-kitsuden-bg/50 transition-colors group"
                  >
                    <td class="px-4 py-3">
                      <input
                        type="checkbox"
                        class="rounded-sm border-kitsuden-border bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent/30"
                        checked={selectedIds.has(doc.id)}
                        onchange={() => toggleSelect(doc.id)}
                      />
                    </td>
                    <td class="px-4 py-3 font-mono text-kitsuden-subtle">{doc.code}</td>
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-2">
                        {#if doc.requiresReview || isOverdue(doc.reviewDueDate)}
                          <span title={tr("dMSView.reviewOverdue")}
                            ><AlertCircle class="w-3.5 h-3.5 text-red-500 shrink-0" /></span
                          >
                        {/if}
                        <span class="font-medium text-kitsuden-text">{doc.title}</span>
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <span
                        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs"
                        style="background-color: {type.color}20; color: {type.color}"
                      >
                        <span>{type.icon}</span>
                        {type.label}
                      </span>
                    </td>
                    <td class="px-4 py-3">
                      <span
                        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs {statusBadgeClass(
                          doc.status
                        )}"
                      >
                        <status.icon class="w-3 h-3" />
                        {status.label}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-kitsuden-subtle">{doc.categoryName || "—"}</td>
                    <td class="px-4 py-3 font-mono text-kitsuden-subtle"
                      >v{doc.currentVersionNumber}</td
                    >
                    <td class="px-4 py-3 text-kitsuden-subtle">{formatDate(doc.updatedAt)}</td>
                    <td class="px-4 py-3">
                      <div
                        class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <button
                          class="p-1.5 hover:bg-kitsuden-card rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
                          title={tr("common.edit")}
                          onclick={() => openDrawer(doc)}
                        >
                          <Edit2 class="w-3.5 h-3.5" />
                        </button>
                        {#if doc.isTemplate}
                          <button
                            class="p-1.5 hover:bg-kitsuden-card rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent"
                            title={tr("dMSView.clone")}
                            onclick={() => cloneFromTemplate(doc.id)}
                          >
                            <Copy class="w-3.5 h-3.5" />
                          </button>
                        {/if}
                        <button
                          class="p-1.5 hover:bg-kitsuden-card rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent-2"
                          title={tr("common.delete")}
                          onclick={() => {
                            deleteTargetIds = [doc.id];
                            showConfirmDeleteModal = true;
                          }}
                        >
                          <Trash2 class="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>

        <!-- Pagination -->
        {#if totalPages > 1}
          <div
            class="p-3 border-t border-kitsuden-border bg-kitsuden-card shrink-0 flex items-center justify-between"
          >
            <span class="text-xs text-kitsuden-subtle">
              {tr("dMSView.totalPageOf", { totalDocs, currentPage, totalPages })}
            </span>
            <div class="flex items-center gap-2">
              <button
                class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                disabled={currentPage === 1}
                onclick={() => {
                  currentPage = 1;
                  loadDocuments();
                }}
              >
                <ChevronFirst class="w-3.5 h-3.5" />
              </button>
              <button
                class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                disabled={currentPage === 1}
                onclick={() => {
                  currentPage--;
                  loadDocuments();
                }}
              >
                <ChevronLeft class="w-3.5 h-3.5" />
              </button>
              <span class="text-xs text-kitsuden-subtle px-2">{currentPage} / {totalPages}</span>
              <button
                class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                disabled={currentPage === totalPages}
                onclick={() => {
                  currentPage++;
                  loadDocuments();
                }}
              >
                <ChevronRight class="w-3.5 h-3.5" />
              </button>
              <button
                class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                disabled={currentPage === totalPages}
                onclick={() => {
                  currentPage = totalPages;
                  loadDocuments();
                }}
              >
                <ChevronLast class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        {/if}
      {/if}

      {#if activeSection === "categories"}
        <div class="flex-1 overflow-auto p-6">
          <div class="max-w-4xl mx-auto">
            <h2 class="text-lg font-semibold text-kitsuden-text mb-4">
              {tr("dMSView.categoryTree")}
            </h2>
            {#if categories.length === 0}
              <div class="card p-12 text-center">
                <FolderTree class="w-10 h-10 text-kitsuden-text-dim mx-auto mb-3" />
                <p class="text-kitsuden-text-dim">{tr("dMSView.noCategoriesYet")}</p>
                <button class="btn-primary mt-4" onclick={() => (showCreateCatModal = true)}>
                  <Plus class="w-4 h-4" />
                  {tr("dMSView.createCategory")}
                </button>
              </div>
            {:else}
              <div class="space-y-2">
                {#each categories as cat}
                  <div class="card p-4">
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-3">
                        <span class="text-2xl">{cat.icon || "📁"}</span>
                        <div>
                          <h3 class="font-semibold text-kitsuden-text">{cat.name}</h3>
                          <p class="text-xs text-kitsuden-subtle">
                            {cat.description || tr("dMSView.noDescription")}
                            {tr("dMSView.docs", { v: cat.documentCount || 0 })}
                          </p>
                        </div>
                      </div>
                      <div
                        class="w-4 h-4 rounded-full"
                        style="background-color: {cat.color || '#6366f1'}"
                      ></div>
                    </div>
                    {#if cat.children && cat.children.length > 0}
                      <div class="mt-3 ml-8 space-y-2">
                        {#each cat.children as child}
                          <div
                            class="flex items-center justify-between p-3 rounded-lg bg-kitsuden-bg border border-kitsuden-border"
                          >
                            <div class="flex items-center gap-3">
                              <span class="text-lg">{child.icon || "📂"}</span>
                              <div>
                                <h4 class="font-medium text-kitsuden-text text-sm">
                                  {child.name}
                                </h4>
                                <p class="text-xs text-kitsuden-subtle">
                                  {child.description || ""}
                                  {tr("dMSView.docs", { v: child.documentCount || 0 })}
                                </p>
                              </div>
                            </div>
                            <div
                              class="w-3 h-3 rounded-full"
                              style="background-color: {child.color || '#6366f1'}"
                            ></div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if activeSection === "notifications"}
        <div class="flex-1 overflow-auto p-6">
          <div class="max-w-3xl mx-auto">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-lg font-semibold text-kitsuden-text">
                {tr("dMSView.notificationInbox")}
              </h2>
              {#if unreadCount > 0}
                <button class="btn-secondary btn-sm" onclick={markAllRead}>
                  <CheckCheck class="w-3.5 h-3.5" />
                  {tr("dMSView.markAllRead")}
                </button>
              {/if}
            </div>
            {#if notifications.length === 0}
              <div class="card p-12 text-center">
                <Inbox class="w-10 h-10 text-kitsuden-text-dim mx-auto mb-3" />
                <p class="text-kitsuden-text-dim">{tr("dMSView.noNotifications")}</p>
              </div>
            {:else}
              <div class="space-y-2">
                {#each notifications as n}
                  <div class="card p-4 flex items-start gap-3 {n.read ? 'opacity-70' : ''}">
                    <div
                      class="w-9 h-9 rounded-lg bg-kitsuden-bg flex items-center justify-center shrink-0"
                    >
                      <Bell class="w-4 h-4 text-kitsuden-accent" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between">
                        <h3 class="font-medium text-kitsuden-text text-sm">{n.title}</h3>
                        <span class="text-xs text-kitsuden-subtle"
                          >{formatDateTime(n.createdAt)}</span
                        >
                      </div>
                      <p class="text-xs text-kitsuden-subtle mt-0.5">{n.message || ""}</p>
                      {#if n.documentId}
                        <button
                          class="text-xs text-kitsuden-accent hover:underline mt-1"
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
                        </button>
                      {/if}
                    </div>
                    {#if !n.read}
                      <button
                        class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
                        onclick={() => markNotificationRead(n.id)}
                        title={tr("dMSView.markRead")}
                      >
                        <Check class="w-3.5 h-3.5" />
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
              {#if notifTotalPages > 1}
                <div class="flex items-center justify-center gap-2 mt-4">
                  <button
                    class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                    disabled={notifPage === 1}
                    onclick={() => {
                      notifPage--;
                      loadNotifications();
                    }}
                  >
                    {tr("dMSView.prev")}
                  </button>
                  <span class="text-xs text-kitsuden-subtle">{notifPage} / {notifTotalPages}</span>
                  <button
                    class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                    disabled={notifPage === notifTotalPages}
                    onclick={() => {
                      notifPage++;
                      loadNotifications();
                    }}
                  >
                    {tr("common.next")}
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/if}

      {#if activeSection === "stats"}
        <div class="flex-1 overflow-auto p-6">
          <div class="max-w-6xl mx-auto space-y-6">
            {#if stats}
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="card p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-sm text-kitsuden-subtle">{tr("dMSView.totalDocuments")}</p>
                      <p class="text-3xl font-bold text-kitsuden-text mt-1">
                        {stats.documents?.total || 0}
                      </p>
                    </div>
                    <div
                      class="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center"
                    >
                      <FileText class="w-6 h-6 text-blue-500" />
                    </div>
                  </div>
                </div>
                <div class="card p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-sm text-kitsuden-subtle">{tr("common.published")}</p>
                      <p class="text-3xl font-bold text-kitsuden-text mt-1">
                        {stats.documents?.published || 0}
                      </p>
                    </div>
                    <div
                      class="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center"
                    >
                      <CheckCircle class="w-6 h-6 text-green-500" />
                    </div>
                  </div>
                </div>
                <div class="card p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-sm text-kitsuden-subtle">{tr("dMSView.drafts")}</p>
                      <p class="text-3xl font-bold text-kitsuden-text mt-1">
                        {stats.documents?.draft || 0}
                      </p>
                    </div>
                    <div
                      class="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center"
                    >
                      <Clock class="w-6 h-6 text-yellow-500" />
                    </div>
                  </div>
                </div>
                <div class="card p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-sm text-kitsuden-subtle">{tr("dMSView.inReview")}</p>
                      <p class="text-3xl font-bold text-kitsuden-text mt-1">
                        {stats.documents?.review_pending || 0}
                      </p>
                    </div>
                    <div
                      class="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center"
                    >
                      <ClipboardCheck class="w-6 h-6 text-orange-500" />
                    </div>
                  </div>
                </div>
                <div class="card p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-sm text-kitsuden-subtle">{tr("common.archived")}</p>
                      <p class="text-3xl font-bold text-kitsuden-text mt-1">
                        {stats.documents?.archived || 0}
                      </p>
                    </div>
                    <div
                      class="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center"
                    >
                      <Archive class="w-6 h-6 text-purple-500" />
                    </div>
                  </div>
                </div>
                <div class="card p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-sm text-kitsuden-subtle">{tr("dMSView.upcomingReviews")}</p>
                      <p class="text-3xl font-bold text-kitsuden-text mt-1">
                        {stats.upcomingReviews?.length || 0}
                      </p>
                    </div>
                    <div
                      class="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center"
                    >
                      <AlertCircle class="w-6 h-6 text-red-500" />
                    </div>
                  </div>
                </div>
              </div>

              <!-- Status Distribution Bar -->
              {#if stats.statusDistribution}
                <div class="card p-5">
                  <h3 class="font-semibold text-kitsuden-text mb-4">
                    {tr("dMSView.statusDistribution")}
                  </h3>
                  <div class="space-y-3">
                    {#each Object.entries(stats.statusDistribution) as [status, count]}
                      {@const cfg = getStatusConfig(status)}
                      <div class="flex items-center gap-3">
                        <span class="w-24 text-xs text-kitsuden-subtle truncate">{cfg.label}</span>
                        <div class="flex-1 h-2 bg-kitsuden-bg rounded-full overflow-hidden">
                          <div
                            class="h-full rounded-full"
                            style="width: {Math.min(
                              100,
                              (Number(count) / (stats.documents?.total || 1)) * 100
                            )}%; background-color: {cfg.color}"
                          ></div>
                        </div>
                        <span class="w-8 text-xs text-kitsuden-text text-right">{count}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            {:else}
              <div class="flex items-center justify-center h-64">
                <div
                  class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
                ></div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- DETAIL DRAWER -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->
{#if drawerOpen}
  <div class="fixed inset-0 z-40 flex justify-end">
    <div class="absolute inset-0 bg-black/40 backdrop-blur-xs" onclick={closeDrawer}></div>
    <div
      class="relative w-full max-w-[60%] bg-kitsuden-card border-l border-kitsuden-border h-full flex flex-col shadow-2xl"
    >
      <!-- Drawer Header -->
      <div
        class="flex items-center justify-between px-6 py-4 border-b border-kitsuden-border shrink-0"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-xs font-mono text-kitsuden-subtle">{drawerDoc?.code || "—"}</span>
            {#if drawerDoc?.isTemplate}
              <span
                class="px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 text-[10px] font-medium"
                >{tr("dMSView.template2")}</span
              >
            {/if}
            {#if drawerDoc?.requiresReview || isOverdue(drawerDoc?.reviewDueDate)}
              <span
                class="px-1.5 py-0.5 rounded-sm bg-red-500/10 text-red-400 text-[10px] font-medium"
                >{tr("dMSView.reviewOverdue2")}</span
              >
            {/if}
          </div>
          <h2 class="text-lg font-bold text-kitsuden-text truncate">
            {drawerDoc?.title || tr("dMSView.document")}
          </h2>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          {#if drawerDoc?.isTemplate}
            <button
              class="btn-secondary btn-sm"
              onclick={() => drawerDoc && cloneFromTemplate(drawerDoc.id)}
            >
              <Copy class="w-3.5 h-3.5" />
              {tr("dMSView.clone")}
            </button>
          {/if}
          <button class="btn-secondary btn-sm" onclick={() => exportVersion("md")}>
            <Download class="w-3.5 h-3.5" />
            {tr("dMSView.md")}
          </button>
          <button class="btn-secondary btn-sm" onclick={() => exportVersion("html")}>
            <FileCode class="w-3.5 h-3.5" />
            {tr("dMSView.html")}
          </button>
          <button
            class="btn-danger btn-sm"
            onclick={() => {
              if (drawerDoc) {
                deleteTargetIds = [drawerDoc.id];
                showConfirmDeleteModal = true;
              }
            }}
          >
            <Trash2 class="w-3.5 h-3.5" />
          </button>
          <button
            class="p-2 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
            onclick={closeDrawer}
          >
            <X class="w-5 h-5" />
          </button>
        </div>
      </div>

      <!-- Drawer Tabs -->
      <div
        class="flex items-center gap-1 px-6 py-2 border-b border-kitsuden-border bg-kitsuden-bg/50 shrink-0 overflow-x-auto"
      >
        {#each ["metadata", "content", "versions", "comments", "diagrams", "audit", "backlinks"] as const as tab}
          <button
            class="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 {drawerTab ===
            tab
              ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
              : 'text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-bg'}"
            onclick={() => (drawerTab = tab)}
          >
            {#if tab === "metadata"}<Settings class="w-3.5 h-3.5" />{/if}
            {#if tab === "content"}<FileText class="w-3.5 h-3.5" />{/if}
            {#if tab === "versions"}<GitBranch class="w-3.5 h-3.5" />{/if}
            {#if tab === "comments"}<MessageSquare class="w-3.5 h-3.5" />{/if}
            {#if tab === "diagrams"}<Layers class="w-3.5 h-3.5" />{/if}
            {#if tab === "audit"}<Activity class="w-3.5 h-3.5" />{/if}
            {#if tab === "backlinks"}<Link2 class="w-3.5 h-3.5" />{/if}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {#if tab === "comments" && comments.length > 0}
              <span
                class="px-1 py-0 rounded-full bg-kitsuden-accent/20 text-kitsuden-accent text-[9px]"
                >{comments.length}</span
              >
            {/if}
            {#if tab === "versions" && versions.length > 0}
              <span
                class="px-1 py-0 rounded-full bg-kitsuden-accent/20 text-kitsuden-accent text-[9px]"
                >{versions.length}</span
              >
            {/if}
          </button>
        {/each}
      </div>

      <!-- Drawer Body -->
      <div class="flex-1 overflow-y-auto p-6">
        {#if drawerLoading}
          <div class="flex items-center justify-center h-full">
            <div
              class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
            ></div>
          </div>
        {:else if !drawerDoc}
          <div class="text-center text-kitsuden-subtle">{tr("dMSView.noDocumentSelected")}</div>
        {:else if drawerTab === "metadata"}
          <!-- Metadata Tab -->
          <div class="max-w-2xl space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="title" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("common.title")}</label
                >
                <input id="title" class="kitsuden-input w-full" bind:value={formDoc.title} />
              </div>
              <div>
                <label for="code" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("dMSView.code")}</label
                >
                <input
                  id="code"
                  class="kitsuden-input w-full font-mono"
                  bind:value={formDoc.code}
                />
              </div>
              <div>
                <label for="slug" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("common.slug")}</label
                >
                <input id="slug" class="kitsuden-input w-full" bind:value={formDoc.slug} />
              </div>
              <div>
                <label for="type" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("common.type")}</label
                >
                <select id="type" class="kitsuden-input w-full" bind:value={formDoc.type}>
                  {#each documentTypes as t}
                    <option value={t.id}>{t.label}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label for="status" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("common.status")}</label
                >
                <select id="status" class="kitsuden-input w-full" bind:value={formDoc.status}>
                  {#each workflowStatuses as s}
                    <option value={s.id}>{s.label}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label for="categoryid" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("common.category")}</label
                >
                <select
                  id="categoryid"
                  class="kitsuden-input w-full"
                  bind:value={formDoc.categoryId}
                >
                  <option value="">{tr("dMSView.none")}</option>
                  {#each categories as c}
                    <option value={c.id}>{c.name}</option>
                    {#each c.children || [] as child}
                      <option value={child.id}> {child.name}</option>
                    {/each}
                  {/each}
                </select>
              </div>
              <div>
                <label for="visibility" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("common.visibility")}</label
                >
                <select
                  id="visibility"
                  class="kitsuden-input w-full"
                  bind:value={formDoc.visibility}
                >
                  {#each visibilityOptions as v}
                    <option value={v.id}>{v.label}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label for="effectivedate" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("dMSView.effectiveDate")}</label
                >
                <input
                  id="effectivedate"
                  type="date"
                  class="kitsuden-input w-full"
                  bind:value={formDoc.effectiveDate}
                />
              </div>
              <div>
                <label for="reviewduedate" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("dMSView.reviewDueDate")}</label
                >
                <input
                  id="reviewduedate"
                  type="date"
                  class="kitsuden-input w-full {isOverdue(formDoc.reviewDueDate)
                    ? 'border-red-500/50 text-red-400'
                    : ''}"
                  bind:value={formDoc.reviewDueDate}
                />
              </div>
              <div>
                <label for="expirationdate" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("dMSView.expirationDate")}</label
                >
                <input
                  id="expirationdate"
                  type="date"
                  class="kitsuden-input w-full"
                  bind:value={formDoc.expirationDate}
                />
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="reqAck"
                  class="rounded-sm border-kitsuden-border bg-kitsuden-bg text-kitsuden-accent focus:ring-kitsuden-accent/30"
                  bind:checked={formDoc.requiresAcknowledgment}
                />
                <label for="reqAck" class="text-sm text-kitsuden-text"
                  >{tr("dMSView.requiresAcknowledgment")}</label
                >
              </div>
            </div>
            <div>
              <label for="description" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("common.description")}</label
              >
              <textarea
                id="description"
                rows="3"
                class="kitsuden-input w-full"
                bind:value={formDoc.description}></textarea>
            </div>
            <div>
              <label for="tags-comma-separated" class="block text-xs text-kitsuden-subtle mb-1"
                >{tr("dMSView.tagsCommaSeparated")}</label
              >
              <input
                id="tags-comma-separated"
                class="kitsuden-input w-full"
                value={Array.isArray(formDoc.tags) ? formDoc.tags.join(", ") : formDoc.tags}
                oninput={(e) => {
                  formDoc.tags = (e.target as HTMLInputElement).value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                }}
              />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="title-2" class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("dMSView.allowedUserIdsCommaSeparated")}</label
                >
                <input
                  class="kitsuden-input w-full"
                  value={Array.isArray(formDoc.allowedUserIds)
                    ? formDoc.allowedUserIds.join(", ")
                    : ""}
                  oninput={(e) => {
                    formDoc.allowedUserIds = (e.target as HTMLInputElement).value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean);
                  }}
                />
              </div>
              <div>
                <label class="block text-xs text-kitsuden-subtle mb-1"
                  >{tr("dMSView.allowedRoleIdsCommaSeparated")}</label
                >
                <input
                  class="kitsuden-input w-full"
                  value={Array.isArray(formDoc.allowedRoleIds)
                    ? formDoc.allowedRoleIds.join(", ")
                    : ""}
                  oninput={(e) => {
                    formDoc.allowedRoleIds = (e.target as HTMLInputElement).value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean);
                  }}
                />
              </div>
            </div>
            <div class="flex items-center gap-3 pt-4 border-t border-kitsuden-border">
              <button class="btn-primary" onclick={updateDocument} disabled={saving}>
                {#if saving}
                  <Loader2 class="w-4 h-4 animate-spin" />
                  {tr("common.saving")}
                {:else}
                  <Save class="w-4 h-4" />
                  {tr("dMSView.saveChanges")}
                {/if}
              </button>
              <button class="btn-secondary" onclick={closeDrawer}>{tr("dMSView.close")}</button>
            </div>
          </div>
        {:else if drawerTab === "content"}
          <!-- Content Tab -->
          <div class="h-full flex flex-col gap-3">
            <div class="flex items-center gap-3 shrink-0">
              <select class="kitsuden-input w-32" bind:value={contentFormat}>
                <option value="markdown">{tr("common.markdown")}</option>
                <option value="html">{tr("dMSView.html")}</option>
              </select>
              <button class="btn-secondary btn-sm" onclick={insertDiagramPlaceholder}>
                <Layers class="w-3.5 h-3.5" />
                {tr("dMSView.insertDiagram")}
              </button>
              <button
                class="btn-secondary btn-sm"
                onclick={() => {
                  contentEditor += "[[";
                }}
              >
                <Link2 class="w-3.5 h-3.5" />
                {tr("dMSView.wikiLink")}
              </button>
              <div class="ml-auto flex items-center gap-2">
                <button class="btn-primary btn-sm" onclick={saveVersionContent} disabled={saving}>
                  {#if saving}<Loader2 class="w-3.5 h-3.5 animate-spin" />{/if}
                  {tr("dMSView.saveContent")}
                </button>
              </div>
            </div>
            <div class="flex-1 flex gap-3 min-h-0">
              <div class="flex-1 flex flex-col min-h-0 relative">
                <textarea
                  id="content-editor"
                  class="flex-1 kitsuden-input font-mono text-xs resize-none"
                  bind:value={contentEditor}
                  oninput={onContentInput}
                  placeholder={tr("dMSView.writeYourContentHere")}></textarea>
                {#if showWikiDropdown && wikiSuggestions.length > 0}
                  <div
                    class="absolute left-4 bottom-4 w-64 max-h-48 overflow-y-auto bg-kitsuden-card border border-kitsuden-border rounded-xl shadow-xl z-10"
                  >
                    {#each wikiSuggestions as s}
                      <button
                        class="w-full text-left px-3 py-2 text-sm text-kitsuden-text hover:bg-kitsuden-bg flex items-center gap-2"
                        onclick={() => insertWikiLink(s)}
                      >
                        <span class="font-mono text-xs text-kitsuden-subtle">{s.code}</span>
                        <span class="truncate">{s.title}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <div
                class="flex-1 bg-kitsuden-bg border border-kitsuden-border rounded-xl overflow-auto p-4"
              >
                <div class="text-xs text-kitsuden-subtle mb-2 flex items-center gap-1">
                  <Eye class="w-3 h-3" />
                  {tr("common.preview")}
                </div>
                {#if renderedHtml}
                  <div class="prose prose-invert prose-sm max-w-none">
                    {@html cleanHtml(renderedHtml)}
                  </div>
                {:else}
                  <p class="text-sm text-kitsuden-subtle">
                    {tr("dMSView.previewWillAppearHereAfter")}
                  </p>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-3 shrink-0 pt-2 border-t border-kitsuden-border">
              <input
                class="kitsuden-input flex-1 text-sm"
                placeholder={tr("dMSView.changelogForThisEdit")}
                bind:value={changelogInput}
              />
              <select class="kitsuden-input w-28 text-sm" bind:value={changeTypeInput}>
                <option value="major">{tr("dMSView.major")}</option>
                <option value="minor">{tr("dMSView.minor")}</option>
                <option value="patch">{tr("dMSView.patch")}</option>
              </select>
              <button
                class="btn-primary btn-sm"
                onclick={createNewVersion}
                disabled={saving || !changelogInput.trim()}
              >
                <GitCommit class="w-3.5 h-3.5" />
                {tr("dMSView.newVersion")}
              </button>
            </div>
          </div>
        {:else if drawerTab === "versions"}
          <!-- Versions Tab -->
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.versionHistory")}</h3>
              <button class="btn-primary btn-sm" onclick={() => (showCreateVersionModal = true)}>
                <Plus class="w-3.5 h-3.5" />
                {tr("dMSView.createVersion")}
              </button>
            </div>
            {#if versions.length === 0}
              <div class="card p-8 text-center text-kitsuden-subtle text-sm">
                {tr("dMSView.noVersionsYet")}
              </div>
            {:else}
              <div class="space-y-2">
                {#each versions as v}
                  <div class="card p-4 flex items-start gap-4">
                    <div
                      class="w-10 h-10 rounded-lg bg-kitsuden-bg flex items-center justify-center shrink-0"
                    >
                      <GitCommit class="w-5 h-5 text-kitsuden-accent" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                          <span class="font-mono text-sm text-kitsuden-text"
                            >v{v.versionNumber}</span
                          >
                          <span
                            class="px-2 py-0.5 rounded-full text-[10px] font-medium {statusBadgeClass(
                              v.status
                            )}">{getStatusConfig(v.status).label}</span
                          >
                        </div>
                        <span class="text-xs text-kitsuden-subtle"
                          >{formatDateTime(v.createdAt)}</span
                        >
                      </div>
                      <p class="text-xs text-kitsuden-subtle mt-1">
                        {v.changelog || tr("dMSView.noChangelog")}
                      </p>
                      <p class="text-xs text-kitsuden-text-dim">
                        {tr("dMSView.by")}
                        {v.createdBy?.name || tr("dMSView.unknown")}
                      </p>
                      <div class="flex items-center gap-2 mt-2">
                        {#if v.status === "draft"}
                          <button
                            class="btn-secondary btn-sm"
                            onclick={() => submitForReview(v.id)}
                          >
                            <Send class="w-3 h-3" />
                            {tr("dMSView.submitForReview")}
                          </button>
                        {:else if v.status === "review_pending"}
                          <button
                            class="btn-primary btn-sm"
                            onclick={() => reviewVersion(v.id, "approved")}
                          >
                            <Check class="w-3 h-3" />
                            {tr("dMSView.approve")}
                          </button>
                          <button
                            class="btn-danger btn-sm"
                            onclick={() => reviewVersion(v.id, "changes_requested")}
                          >
                            <XCircle class="w-3 h-3" />
                            {tr("dMSView.requestChanges")}
                          </button>
                          <input
                            class="kitsuden-input w-48 text-xs"
                            placeholder={tr("dMSView.reviewNotes")}
                            bind:value={reviewNotes}
                          />
                        {:else if v.status === "approved"}
                          <button class="btn-primary btn-sm" onclick={() => publishVersion(v.id)}>
                            <CheckCircle class="w-3 h-3" />
                            {tr("dMSView.publish")}
                          </button>
                        {:else if v.status === "published"}
                          <span class="text-xs text-blue-400 flex items-center gap-1">
                            <CheckCircle class="w-3 h-3" />
                            {tr("common.published")}
                          </span>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {:else if drawerTab === "comments"}
          <!-- Comments Tab -->
          <div class="space-y-4">
            <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.comments")}</h3>
            <div class="flex gap-3">
              <div
                class="w-8 h-8 rounded-full bg-kitsuden-accent/20 flex items-center justify-center text-kitsuden-accent text-xs font-bold shrink-0"
              >
                {getInitials("You")}
              </div>
              <div class="flex-1">
                {#if replyToId}
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs text-kitsuden-accent"
                      >{tr("dMSView.replyingToComment")}</span
                    >
                    <button
                      class="text-xs text-kitsuden-subtle hover:text-kitsuden-text"
                      onclick={() => (replyToId = null)}>{tr("common.cancel")}</button
                    >
                  </div>
                {/if}
                <textarea
                  rows="2"
                  class="kitsuden-input w-full text-sm"
                  placeholder={tr("dMSView.addAComment")}
                  bind:value={commentInput}></textarea>
                <div class="flex justify-end mt-2">
                  <button
                    class="btn-primary btn-sm"
                    onclick={postComment}
                    disabled={!commentInput.trim()}
                  >
                    <Send class="w-3 h-3" />
                    {tr("dMSView.post")}
                  </button>
                </div>
              </div>
            </div>
            <div class="space-y-3">
              {#each comments.filter((c) => !c.parentId) as comment}
                <div class="card p-4">
                  <div class="flex items-start gap-3">
                    <div
                      class="w-8 h-8 rounded-full bg-kitsuden-bg border border-kitsuden-border flex items-center justify-center text-kitsuden-text text-xs font-bold shrink-0"
                    >
                      {getInitials(comment.createdBy?.name)}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between">
                        <span class="text-sm font-medium text-kitsuden-text"
                          >{comment.createdBy?.name || tr("dMSView.unknown")}</span
                        >
                        <span class="text-xs text-kitsuden-subtle"
                          >{formatDateTime(comment.createdAt)}</span
                        >
                      </div>
                      <p class="text-sm text-kitsuden-subtle mt-1">{comment.content}</p>
                      <div class="flex items-center gap-2 mt-2">
                        <button
                          class="text-xs text-kitsuden-subtle hover:text-kitsuden-accent flex items-center gap-1"
                          onclick={() => (replyToId = comment.id)}
                        >
                          <Reply class="w-3 h-3" />
                          {tr("dMSView.reply")}
                        </button>
                        {#if !comment.resolved}
                          <button
                            class="text-xs text-kitsuden-subtle hover:text-green-400 flex items-center gap-1"
                            onclick={() => resolveComment(comment.id)}
                          >
                            <Check class="w-3 h-3" />
                            {tr("dMSView.resolve")}
                          </button>
                        {:else}
                          <span class="text-xs text-green-400 flex items-center gap-1">
                            <CheckCircle class="w-3 h-3" />
                            {tr("dMSView.resolved")}
                          </span>
                        {/if}
                        <button
                          class="text-xs text-kitsuden-subtle hover:text-kitsuden-accent-2 flex items-center gap-1"
                          onclick={() => deleteComment(comment.id)}
                        >
                          <Trash2 class="w-3 h-3" />
                          {tr("common.delete")}
                        </button>
                      </div>
                      {#if comment.replies && comment.replies.length > 0}
                        <div class="mt-3 ml-4 pl-3 border-l border-kitsuden-border space-y-2">
                          {#each comment.replies as reply}
                            <div class="flex items-start gap-2">
                              <div
                                class="w-6 h-6 rounded-full bg-kitsuden-bg border border-kitsuden-border flex items-center justify-center text-kitsuden-text text-[10px] font-bold shrink-0"
                              >
                                {getInitials(reply.createdBy?.name)}
                              </div>
                              <div class="flex-1">
                                <div class="flex items-center gap-2">
                                  <span class="text-xs font-medium text-kitsuden-text"
                                    >{reply.createdBy?.name || tr("dMSView.unknown")}</span
                                  >
                                  <span class="text-[10px] text-kitsuden-subtle"
                                    >{formatDateTime(reply.createdAt)}</span
                                  >
                                </div>
                                <p class="text-xs text-kitsuden-subtle mt-0.5">{reply.content}</p>
                              </div>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
              {#if comments.length === 0}
                <div class="text-center text-kitsuden-subtle text-sm py-8">
                  {tr("dMSView.noCommentsYet")}
                </div>
              {/if}
            </div>
          </div>
        {:else if drawerTab === "diagrams"}
          <!-- Diagrams Tab -->
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.diagrams")}</h3>
              <button class="btn-primary btn-sm" onclick={() => (showCreateDiagramModal = true)}>
                <Plus class="w-3.5 h-3.5" />
                {tr("dMSView.addDiagram")}
              </button>
            </div>
            {#if diagrams.length === 0}
              <div class="card p-8 text-center text-kitsuden-subtle text-sm">
                {tr("dMSView.noDiagramsForThisVersion")}
              </div>
            {:else}
              <div class="grid grid-cols-1 gap-3">
                {#each diagrams as d}
                  <div class="card p-4">
                    <div class="flex items-center justify-between mb-2">
                      <h4 class="font-medium text-kitsuden-text text-sm">{d.name}</h4>
                      <button
                        class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent-2"
                        onclick={() => deleteDiagram(d.id)}
                      >
                        <Trash2 class="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {#if d.renderedSvg}
                      <div class="bg-white rounded-lg p-2 overflow-auto">
                        {@html cleanSvg(d.renderedSvg)}
                      </div>
                    {:else if d.sourceXml}
                      <pre
                        class="text-xs text-kitsuden-subtle bg-kitsuden-bg p-3 rounded-lg overflow-auto max-h-40">{d.sourceXml.slice(
                          0,
                          500
                        )}{d.sourceXml.length > 500 ? "..." : ""}</pre>
                    {:else}
                      <p class="text-xs text-kitsuden-subtle">{tr("dMSView.noPreviewAvailable")}</p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {:else if drawerTab === "audit"}
          <!-- Audit Tab -->
          <div class="space-y-4">
            <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.auditLog")}</h3>
            {#if auditEntries.length === 0}
              <div class="card p-8 text-center text-kitsuden-subtle text-sm">
                {tr("dMSView.noAuditEntries")}
              </div>
            {:else}
              <div class="relative pl-4 border-l border-kitsuden-border space-y-4">
                {#each auditEntries as entry}
                  <div class="relative">
                    <div
                      class="absolute left-[-21px] top-0 w-2.5 h-2.5 rounded-full bg-kitsuden-accent border-2 border-kitsuden-card"
                    ></div>
                    <div class="card p-3">
                      <div class="flex items-center justify-between">
                        <span class="text-sm font-medium text-kitsuden-text">{entry.action}</span>
                        <span class="text-xs text-kitsuden-subtle"
                          >{formatDateTime(entry.createdAt)}</span
                        >
                      </div>
                      <p class="text-xs text-kitsuden-subtle mt-1">
                        {tr("dMSView.by")}
                        {entry.user?.name || tr("common.system")}
                      </p>
                      {#if entry.details}
                        <pre
                          class="text-[10px] text-kitsuden-text-dim bg-kitsuden-bg p-2 rounded-sm mt-2 overflow-auto">{JSON.stringify(
                            entry.details,
                            null,
                            2
                          )}</pre>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {:else if drawerTab === "backlinks"}
          <!-- Backlinks Tab -->
          <div class="space-y-4">
            <h3 class="font-semibold text-kitsuden-text">{tr("dMSView.backlinks")}</h3>
            <p class="text-sm text-kitsuden-subtle">{tr("dMSView.documentsThatLinkToThis")}</p>
            {#if backlinks.length === 0}
              <div class="card p-8 text-center text-kitsuden-subtle text-sm">
                {tr("dMSView.noBacklinksFound")}
              </div>
            {:else}
              <div class="space-y-2">
                {#each backlinks as bl}
                  <button
                    class="w-full text-left card p-3 hover:border-kitsuden-accent/30 transition-colors"
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
                    <div class="flex items-center gap-3">
                      <Link2 class="w-4 h-4 text-kitsuden-accent" />
                      <div>
                        <p class="text-sm font-medium text-kitsuden-text">{bl.title}</p>
                        <p class="text-xs font-mono text-kitsuden-subtle">{bl.code}</p>
                      </div>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- MODALS -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->

<!-- Create Document Modal -->
{#if showCreateDocModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showCreateDocModal = false)}
    ></div>
    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
    >
      <div class="flex items-center justify-between p-6 border-b border-kitsuden-border">
        <h3 class="text-lg font-semibold text-kitsuden-text">{tr("dMSView.newDocument")}</h3>
        <button
          onclick={() => (showCreateDocModal = false)}
          class="p-2 rounded-xl text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-bg transition-all"
        >
          <X class="w-5 h-5" />
        </button>
      </div>
      <form onsubmit={createDocument} class="p-6 space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-kitsuden-subtle mb-1">{tr("dMSView.title")}</label>
            <input
              id="title-2"
              bind:value={formDoc.title}
              type="text"
              placeholder={tr("dMSView.documentTitle")}
              class="kitsuden-input w-full"
              required
            />
          </div>
          <div>
            <label for="type-2" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("common.type")}</label
            >
            <select id="type-2" bind:value={formDoc.type} class="kitsuden-input w-full">
              {#each documentTypes as t}
                <option value={t.id}>{t.label}</option>
              {/each}
            </select>
          </div>
        </div>
        <div>
          <label for="description-2" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("common.description")}</label
          >
          <textarea
            id="description-2"
            bind:value={formDoc.description}
            rows="3"
            placeholder={tr("dMSView.shortDescription")}
            class="kitsuden-input w-full"></textarea>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="status-2" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("common.status")}</label
            >
            <select id="status-2" bind:value={formDoc.status} class="kitsuden-input w-full">
              {#each workflowStatuses as s}
                <option value={s.id}>{s.label}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="categoryid-2" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("common.category")}</label
            >
            <select id="categoryid-2" bind:value={formDoc.categoryId} class="kitsuden-input w-full">
              <option value="">{tr("dMSView.noCategory")}</option>
              {#each categories as cat}
                <option value={cat.id}>{cat.name}</option>
                {#each cat.children || [] as child}
                  <option value={child.id}> {child.name}</option>
                {/each}
              {/each}
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="visibility-2" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("common.visibility")}</label
            >
            <select id="visibility-2" bind:value={formDoc.visibility} class="kitsuden-input w-full">
              {#each visibilityOptions as v}
                <option value={v.id}>{v.label}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="tags-comma-separated-2" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("dMSView.tagsCommaSeparated")}</label
            >
            <input
              id="tags-comma-separated-2"
              type="text"
              placeholder={tr("dMSView.policyHr2025")}
              class="kitsuden-input w-full"
              oninput={(e) => {
                formDoc.tags = (e.target as HTMLInputElement).value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean);
              }}
            />
          </div>
        </div>
        <div class="flex justify-end gap-3 pt-4 border-t border-kitsuden-border">
          <button type="button" onclick={() => (showCreateDocModal = false)} class="btn-secondary"
            >{tr("common.cancel")}</button
          >
          <button type="submit" disabled={saving || !formDoc.title} class="btn-primary">
            {#if saving}
              <span
                class="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"
              ></span>
              {tr("common.creating")}
            {:else}
              <Plus class="w-4 h-4" />
              {tr("dMSView.createDocument")}
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Create Category Modal -->
{#if showCreateCatModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showCreateCatModal = false)}
    ></div>
    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto"
    >
      <div class="flex items-center justify-between p-6 border-b border-kitsuden-border">
        <h3 class="text-lg font-semibold text-kitsuden-text">{tr("dMSView.newCategory")}</h3>
        <button
          onclick={() => (showCreateCatModal = false)}
          class="p-2 rounded-xl text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-bg transition-all"
        >
          <X class="w-5 h-5" />
        </button>
      </div>
      <form onsubmit={saveCategory} class="p-6 space-y-4">
        <div>
          <label for="newcategoryname" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("common.name2")}</label
          >
          <input
            id="newcategoryname"
            bind:value={newCategoryName}
            type="text"
            placeholder={tr("dMSView.categoryName")}
            class="kitsuden-input w-full"
            required
          />
        </div>
        <div>
          <label for="newcategorydescription" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("common.description")}</label
          >
          <textarea
            id="newcategorydescription"
            bind:value={newCategoryDescription}
            rows="2"
            placeholder={tr("dMSView.shortDescription")}
            class="kitsuden-input w-full"></textarea>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="newcategoryicon" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("dMSView.icon")}</label
            >
            <input
              id="newcategoryicon"
              bind:value={newCategoryIcon}
              type="text"
              placeholder="📁"
              class="kitsuden-input w-full"
            />
          </div>
          <div>
            <label for="newcategorycolor" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("dMSView.color")}</label
            >
            <input
              id="newcategorycolor"
              bind:value={newCategoryColor}
              type="color"
              class="w-full h-10 bg-kitsuden-bg border border-kitsuden-border rounded-lg px-2 py-1"
            />
          </div>
        </div>
        <div>
          <label for="newcategoryparentid" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("dMSView.parentCategory")}</label
          >
          <select
            id="newcategoryparentid"
            bind:value={newCategoryParentId}
            class="kitsuden-input w-full"
          >
            <option value="">{tr("dMSView.noneRoot")}</option>
            {#each categories as cat}
              <option value={cat.id}>{cat.name}</option>
            {/each}
          </select>
        </div>
        <div class="flex justify-end gap-3 pt-4 border-t border-kitsuden-border">
          <button type="button" onclick={() => (showCreateCatModal = false)} class="btn-secondary"
            >{tr("common.cancel")}</button
          >
          <button type="submit" disabled={saving || !newCategoryName} class="btn-primary">
            {#if saving}
              <span
                class="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"
              ></span>
              {tr("common.creating")}
            {:else}
              <Plus class="w-4 h-4" />
              {tr("dMSView.createCategory")}
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Confirm Delete Modal -->
{#if showConfirmDeleteModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showConfirmDeleteModal = false)}
    ></div>
    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6"
    >
      <div class="flex items-center gap-3 mb-4">
        <div
          class="w-10 h-10 rounded-full bg-kitsuden-accent-2/10 flex items-center justify-center"
        >
          <AlertCircle class="w-5 h-5 text-kitsuden-accent-2" />
        </div>
        <h3 class="text-lg font-semibold text-kitsuden-text">{tr("dMSView.confirmDeletion")}</h3>
      </div>
      <p class="text-sm text-kitsuden-subtle mb-6">
        {tr("dMSView.areYouSureYouWant", { deleteTargetIdsCount: deleteTargetIds.length })}
      </p>
      <div class="flex justify-end gap-3">
        <button class="btn-secondary" onclick={() => (showConfirmDeleteModal = false)}
          >{tr("common.cancel")}</button
        >
        <button class="btn-danger" onclick={() => deleteDocuments(deleteTargetIds)}>
          <Trash2 class="w-4 h-4" />
          {tr("common.delete")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Create Version Modal -->
{#if showCreateVersionModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showCreateVersionModal = false)}
    ></div>
    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6"
    >
      <h3 class="text-lg font-semibold text-kitsuden-text mb-4">
        {tr("dMSView.createNewVersion")}
      </h3>
      <div class="space-y-4">
        <div>
          <label for="changetypeinput" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("dMSView.changeType")}</label
          >
          <select id="changetypeinput" class="kitsuden-input w-full" bind:value={changeTypeInput}>
            <option value="major">{tr("dMSView.major")}</option>
            <option value="minor">{tr("dMSView.minor")}</option>
            <option value="patch">{tr("dMSView.patch")}</option>
          </select>
        </div>
        <div>
          <label for="changeloginput" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("dMSView.changelog")}</label
          >
          <textarea
            id="changeloginput"
            rows="3"
            class="kitsuden-input w-full"
            placeholder={tr("dMSView.describeWhatChanged")}
            bind:value={changelogInput}></textarea>
        </div>
        <div class="flex justify-end gap-3 pt-2">
          <button class="btn-secondary" onclick={() => (showCreateVersionModal = false)}
            >{tr("common.cancel")}</button
          >
          <button
            class="btn-primary"
            onclick={createNewVersion}
            disabled={saving || !changelogInput.trim()}
          >
            {#if saving}<Loader2 class="w-4 h-4 animate-spin" />{/if}
            {tr("dMSView.createVersion")}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Create Diagram Modal -->
{#if showCreateDiagramModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showCreateDiagramModal = false)}
    ></div>
    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6"
    >
      <h3 class="text-lg font-semibold text-kitsuden-text mb-4">{tr("dMSView.addDiagram")}</h3>
      <form onsubmit={createDiagram} class="space-y-4">
        <div>
          <label for="newdiagramname" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("common.name")}</label
          >
          <input
            id="newdiagramname"
            type="text"
            class="kitsuden-input w-full"
            bind:value={newDiagramName}
            placeholder={tr("dMSView.diagramName")}
            required
          />
        </div>
        <div>
          <label for="newdiagramsource" class="block text-xs text-kitsuden-subtle mb-1"
            >{tr("dMSView.sourceXmlJson")}</label
          >
          <textarea
            id="newdiagramsource"
            rows="6"
            class="kitsuden-input w-full font-mono text-xs"
            bind:value={newDiagramSource}
            placeholder={tr("dMSView.pasteDiagramSourceXmlOr")}></textarea>
        </div>
        <div class="flex justify-end gap-3 pt-2">
          <button
            type="button"
            class="btn-secondary"
            onclick={() => (showCreateDiagramModal = false)}>{tr("common.cancel")}</button
          >
          <button type="submit" class="btn-primary" disabled={saving || !newDiagramName}>
            {#if saving}<Loader2 class="w-4 h-4 animate-spin" />{/if}
            {tr("dMSView.addDiagram")}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<!-- TOASTS -->
<!-- ═══════════════════════════════════════════════════════════════════════════ -->
<div class="fixed bottom-6 right-6 z-60 space-y-2 pointer-events-none">
  {#each toasts as toast}
    <div
      class="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium min-w-[280px] transition-all duration-300
      {toast.type === 'success'
        ? 'bg-kitsuden-card border-green-500/30 text-green-400'
        : toast.type === 'error'
          ? 'bg-kitsuden-card border-red-500/30 text-red-400'
          : 'bg-kitsuden-card border-kitsuden-accent/30 text-kitsuden-accent'}"
    >
      {#if toast.type === "success"}<CheckCircle class="w-4 h-4 shrink-0" />{/if}
      {#if toast.type === "error"}<AlertCircle class="w-4 h-4 shrink-0" />{/if}
      {#if toast.type === "info"}<Sparkles class="w-4 h-4 shrink-0" />{/if}
      <span>{toast.message}</span>
    </div>
  {/each}
</div>

<style>
  @reference "../../style.css";

  .btn-primary {
    @apply inline-flex items-center gap-2 px-4 py-2 bg-kitsuden-accent text-kitsuden-bg rounded-lg font-medium hover:bg-kitsuden-accent-dim active:scale-[0.98] transition-all disabled:opacity-50;
  }
  .btn-secondary {
    @apply inline-flex items-center gap-2 px-4 py-2 bg-kitsuden-card border border-kitsuden-border text-kitsuden-text rounded-lg hover:bg-kitsuden-muted/30 transition-all disabled:opacity-50;
  }
  .btn-danger {
    @apply inline-flex items-center gap-2 px-4 py-2 bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border border-kitsuden-accent-2/20 rounded-lg hover:bg-kitsuden-accent-2/20 transition-all disabled:opacity-50;
  }
  .btn-sm {
    @apply px-3 py-1.5 text-xs gap-1.5;
  }
  .kitsuden-input {
    @apply bg-kitsuden-bg border border-kitsuden-border rounded-lg px-3 py-2 text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:ring-1 focus:ring-kitsuden-accent/50 focus:border-kitsuden-accent/50 transition-all duration-150;
  }
</style>
