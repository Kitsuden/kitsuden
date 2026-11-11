<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    GraduationCap,
    BookOpen,
    Users,
    TrendingUp,
    Star,
    Plus,
    Search,
    ChevronLeft,
    ChevronRight,
    ChevronFirst,
    ChevronLast,
    X,
    Eye,
    Edit2,
    Trash2,
    Route,
    UserCircle,
    CheckCircle,
    AlertCircle,
    Loader2,
    BarChart3,
    Layers,
  } from "lucide-svelte";
  import { onMount } from "svelte";
  import {
    toast,
    Dialog,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Button,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  // ─── Types ──────────────────────────────────────────────────────────────

  interface Metrics {
    totalCourses: number;
    totalModules: number;
    totalTopics: number;
    totalQuizzes: number;
    totalQuestions: number;
    totalGroups: number;
    totalAssignments: number;
    totalCompletedCourses: number;
    totalFeedbacks: number;
    totalSurveys: number;
    totalAvailableHours: number;
    averageCourseDuration: number;
    completionRate: number;
    averageModules: number;
    averageTopics: number;
  }

  interface CourseReport {
    course: { id: string; title: string; type: string };
    metrics: {
      assignments: number;
      completedItems: number;
      averageProgress: number;
      finishRate: number;
      totalSurveys: number;
      averageSatisfaction: number;
    };
  }

  interface CourseStats {
    totalAssigned: number;
    completedItems: number;
    inProgress: number;
    notStarted: number;
    finishRate: number;
    averageProgress: number;
    passedQuiz: number;
    averageQuizScore: number;
    totalSurveys: number;
    averageSatisfaction: number;
    averageExhibitor: number;
  }

  interface LearningPath {
    id: string;
    name: string;
    description?: string;
    category?: string;
    active: boolean;
    totalCourses: number;
    sequential?: boolean;
  }

  interface Group {
    id: string;
    name: string;
    description?: string;
    supervisorPrincipal?: string;
    members: number;
  }

  interface Assignment {
    id: string;
    courseId: string;
    userId?: string;
    groupId?: string;
    method?: string;
    date: string;
  }

  // ─── Constants ──────────────────────────────────────────────────────────

  const courseTypeLabels: Record<string, string> = {
    INDUCCION: "Onboarding",
    GESTION: "Management",
    TECNICO: "Technical",
    HERRAMIENTAS: "Tools",
    DESARROLLO: "Development",
  };

  const courseTypeColors: Record<string, string> = {
    INDUCCION: "bg-kitsuden-info/15 text-kitsuden-info",
    GESTION: "bg-kitsuden-purple/15 text-kitsuden-purple",
    TECNICO: "bg-kitsuden-amber/15 text-kitsuden-amber",
    HERRAMIENTAS: "bg-kitsuden-green/15 text-kitsuden-green",
    DESARROLLO: "bg-kitsuden-accent-2/15 text-kitsuden-accent-2",
  };

  const tabs = [
    { key: "courses", label: tr("academyView.courses"), icon: BookOpen },
    { key: "paths", label: tr("academyView.learningPaths"), icon: Route },
    { key: "groups", label: tr("academyView.groups"), icon: Users },
    { key: "assignments", label: tr("academyView.assignments"), icon: Layers },
  ] as const;

  const pageSize = 10;

  // ─── State ──────────────────────────────────────────────────────────────

  let loading = $state(true);
  let metrics = $state<Metrics | null>(null);
  let alerts = $state<{ type: string; message: string }[]>([]);

  let reports = $state<CourseReport[]>([]);
  let learningPaths = $state<LearningPath[]>([]);
  let groups = $state<Group[]>([]);
  let assignments = $state<Assignment[]>([]);

  let activeTab = $state<(typeof tabs)[number]["key"]>("courses");

  // Search / sort / pagination
  let searchQuery = $state("");
  let sortKey = $state<keyof CourseReport["metrics"] | "title">("title");
  let sortDir = $state<"asc" | "desc">("asc");
  let currentPage = $state(1);
  let selectedIds = $state<Set<string>>(new Set());

  // Drawer
  let drawerOpen = $state(false);
  let drawerCourse = $state<CourseReport | null>(null);
  let drawerStats = $state<CourseStats | null>(null);
  let drawerLoading = $state(false);

  // Modals
  let showDeleteModal = $state(false);
  let deleteTargetIds = $state<string[]>([]);
  let showAssignModal = $state(false);
  let assignCourseIds = $state<string[]>([]);
  let assignUserIds = $state("");
  let assignGroupIds = $state("");
  let assignLoading = $state(false);

  // ─── Derived ────────────────────────────────────────────────────────────

  const filteredCourses = $derived.by(() => {
    let list = [...reports];
    const q = searchQuery.trim().toLowerCase();
    if (q) list = list.filter((r) => r.course.title.toLowerCase().includes(q));
    list.sort((a, b) => {
      let av: any, bv: any;
      if (sortKey === "title") {
        av = a.course.title;
        bv = b.course.title;
      } else {
        av = a.metrics[sortKey] ?? 0;
        bv = b.metrics[sortKey] ?? 0;
      }
      if (typeof av === "string")
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return list;
  });

  const totalPages = $derived(Math.max(1, Math.ceil(filteredCourses.length / pageSize)));
  const pagedCourses = $derived(
    filteredCourses.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  );

  const allSelected = $derived(
    pagedCourses.length > 0 && pagedCourses.every((r) => selectedIds.has(r.course.id))
  );
  const someSelected = $derived(
    pagedCourses.some((r) => selectedIds.has(r.course.id)) && !allSelected
  );

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  onMount(() => {
    loadAll();
  });

  async function loadAll() {
    loading = true;
    await Promise.all([
      loadDashboard(),
      loadReports(),
      loadPaths(),
      loadGroups(),
      loadAssignments(),
    ]);
    loading = false;
  }

  async function loadDashboard() {
    try {
      const data = await api.getAcademyDashboardAdmin();
      metrics = data.metrics ?? null;
      alerts = data.alerts ?? [];
    } catch (e: any) {
      toast.error(tr("academyView.failedToLoadDashboard"));
    }
  }

  async function loadReports() {
    try {
      const data = await api.getAcademyCourseReports();
      reports = data.reports ?? [];
    } catch (e: any) {
      toast.error(tr("academyView.failedToLoadCourses"));
    }
  }

  async function loadPaths() {
    try {
      const data = await api.getAcademyLearningPaths();
      learningPaths = data.learningPaths ?? [];
    } catch (e: any) {
      toast.error(tr("academyView.failedToLoadLearningPaths"));
    }
  }

  async function loadGroups() {
    try {
      const data = await api.getAcademyGroups();
      groups = data.groups ?? [];
    } catch (e: any) {
      toast.error(tr("academyView.failedToLoadGroups"));
    }
  }

  async function loadAssignments() {
    try {
      const data = await api.getAcademyAssignments();
      assignments = data.assignments ?? [];
    } catch (e: any) {
      toast.error(tr("academyView.failedToLoadAssignments"));
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else {
      sortKey = key;
      sortDir = "asc";
    }
    currentPage = 1;
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
  }

  function toggleSelectAll() {
    const next = new Set(selectedIds);
    if (allSelected) pagedCourses.forEach((r) => next.delete(r.course.id));
    else pagedCourses.forEach((r) => next.add(r.course.id));
    selectedIds = next;
  }

  function openDrawer(summaryReport: CourseReport) {
    drawerCourse = summaryReport;
    drawerOpen = true;
    drawerLoading = true;
    drawerStats = null;
    api
      .getAcademyCourseStatistics(summaryReport.course.id)
      .then((d) => {
        drawerStats = d.stats ?? null;
      })
      .catch(() => toast.error(tr("academyView.failedToLoadCourseStats")))
      .finally(() => {
        drawerLoading = false;
      });
  }

  function closeDrawer() {
    drawerOpen = false;
    drawerCourse = null;
    drawerStats = null;
  }

  function promptDelete(ids: string[]) {
    deleteTargetIds = ids;
    showDeleteModal = true;
  }

  async function confirmDelete() {
    try {
      await Promise.all(deleteTargetIds.map((id) => api.deleteAcademyCourse(id)));
      toast.success(
        tr("academyView.courseSDeleted", { deleteTargetIdsCount: deleteTargetIds.length })
      );
      selectedIds = new Set();
      await loadReports();
      await loadDashboard();
      closeDrawer();
    } catch (e: any) {
      toast.error(tr("academyView.failedToDeleteCourseS"));
    } finally {
      showDeleteModal = false;
      deleteTargetIds = [];
    }
  }

  function openAssignModal(ids?: string[]) {
    assignCourseIds = ids ?? Array.from(selectedIds);
    assignUserIds = "";
    assignGroupIds = "";
    showAssignModal = true;
  }

  async function submitAssign() {
    if (!assignCourseIds.length) return;
    assignLoading = true;
    try {
      await api.createAcademyAssignmentBulk({
        courseIds: assignCourseIds,
        userIds: assignUserIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        groupIds: assignGroupIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      toast.success(tr("academyView.assignmentsCreated"));
      showAssignModal = false;
      await loadAssignments();
      await loadDashboard();
    } catch (e: any) {
      toast.error(tr("academyView.failedToCreateAssignments"));
    } finally {
      assignLoading = false;
    }
  }

  async function deletePath(id: string) {
    if (!(await confirmDialog(tr("academyView.deleteThisLearningPath")))) return;
    try {
      await api.deleteAcademyLearningPath(id);
      toast.success(tr("academyView.learningPathDeleted"));
      await loadPaths();
    } catch {
      toast.error(tr("academyView.failedToDelete"));
    }
  }

  async function deleteGroup(id: string) {
    if (!(await confirmDialog(tr("academyView.deleteThisGroup")))) return;
    try {
      await api.deleteAcademyGroup(id);
      toast.success(tr("academyView.groupDeleted"));
      await loadGroups();
    } catch {
      toast.error(tr("academyView.failedToDelete"));
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  function fmt(n?: number) {
    return n == null ? "—" : String(n);
  }
  function fmtPct(n?: number) {
    return n == null ? "—" : `${Math.round(n)}%`;
  }
  function fmtStar(n?: number) {
    const v = Math.min(5, Math.max(0, Math.round((n ?? 0) * 10) / 10));
    return (
      "★".repeat(Math.floor(v)) +
      (v % 1 >= 0.5 ? "½" : "") +
      "☆".repeat(Math.max(0, 5 - Math.ceil(v)))
    );
  }
  function alertIcon(type: string) {
    return type === "warning" ? AlertCircle : CheckCircle;
  }
  function alertColor(type: string) {
    return type === "warning"
      ? "text-kitsuden-amber bg-kitsuden-amber/10"
      : "text-kitsuden-green bg-kitsuden-green/10";
  }
</script>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- HEADER & STATS                                                        -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->
<ViewPage
  title={tr("academyView.academyLms")}
  description={tr("academyView.courseManagementAssignmentsAnalytics")}
>
  {#snippet actions()}
    <Button href="/g/kon-academy-lms/grid-courses">
      <Plus class="w-4 h-4" />
      {tr("academyView.newCourse")}
    </Button>
  {/snippet}

  <div class="space-y-6">
    {#if alerts.length > 0}
      <div class="space-y-2">
        {#each alerts as a}
          {@const Icon = alertIcon(a.type)}
          <div class="flex items-center gap-2 px-3 py-2 rounded-lg {alertColor(a.type)} text-sm">
            <Icon class="w-4 h-4 shrink-0" />
            <span>{a.message}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Stats Row -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-accent/15 flex items-center justify-center">
          <BookOpen class="w-5 h-5 text-kitsuden-accent" />
        </div>
        <div>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {tr("academyView.totalCourses")}
          </p>
          <p class="text-2xl font-bold text-kitsuden-text">{metrics?.totalCourses ?? 0}</p>
        </div>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-purple/15 flex items-center justify-center">
          <Users class="w-5 h-5 text-kitsuden-purple" />
        </div>
        <div>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {tr("academyView.totalAssignments")}
          </p>
          <p class="text-2xl font-bold text-kitsuden-text">{metrics?.totalAssignments ?? 0}</p>
        </div>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-green/15 flex items-center justify-center">
          <TrendingUp class="w-5 h-5 text-kitsuden-green" />
        </div>
        <div class="flex-1">
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {tr("academyView.completionRate")}
          </p>
          <div class="flex items-center gap-2 mt-1">
            <p class="text-2xl font-bold text-kitsuden-text">{fmtPct(metrics?.completionRate)}</p>
            <div class="flex-1 h-1.5 bg-kitsuden-bg rounded-full overflow-hidden">
              <div
                class="h-full bg-kitsuden-green rounded-full"
                style="width: {metrics?.completionRate ?? 0}%"
              ></div>
            </div>
          </div>
        </div>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-amber/15 flex items-center justify-center">
          <Star class="w-5 h-5 text-kitsuden-amber" />
        </div>
        <div>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {tr("academyView.avgSatisfaction")}
          </p>
          <p class="text-2xl font-bold text-kitsuden-text">
            {metrics?.totalSurveys
              ? ((metrics.totalFeedbacks ?? 0) / (metrics.totalSurveys || 1)).toFixed(1)
              : "—"}<span class="text-sm text-kitsuden-subtle font-normal"> /5</span>
          </p>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="border-b border-kitsuden-border">
      <div class="flex items-center gap-1">
        {#each tabs as t}
          <button
            class="px-4 py-2 text-sm font-medium flex items-center gap-1.5 transition-colors border-b-2 {activeTab ===
            t.key
              ? 'text-kitsuden-accent border-kitsuden-accent'
              : 'text-kitsuden-subtle border-transparent hover:text-kitsuden-text hover:border-kitsuden-border'}"
            onclick={() => {
              activeTab = t.key;
              selectedIds = new Set();
              currentPage = 1;
            }}
          >
            <t.icon class="w-4 h-4" />
            {t.label}
          </button>
        {/each}
      </div>
    </div>

    {#if loading}
      <div class="flex justify-center py-20">
        <div
          class="w-6 h-6 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
        ></div>
      </div>
    {:else}
      <!-- ═══════════════════════════════════════════════════════════════════ -->
      <!-- COURSES TAB                                                       -->
      <!-- ═══════════════════════════════════════════════════════════════════ -->
      {#if activeTab === "courses"}
        <div class="space-y-3">
          <!-- Toolbar -->
          <div class="flex items-center gap-3 flex-wrap">
            <div class="relative flex-1 min-w-[200px] max-w-sm">
              <Search
                class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-text-dim"
              />
              <input
                type="text"
                placeholder={tr("academyView.searchCourses")}
                class="w-full pl-10 pr-4 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-text-dim focus:outline-hidden focus:border-kitsuden-accent/50"
                bind:value={searchQuery}
                oninput={() => (currentPage = 1)}
              />
            </div>
            {#if selectedIds.size > 0}
              <div class="flex items-center gap-2 ml-auto">
                <span class="text-xs text-kitsuden-subtle"
                  >{selectedIds.size} {tr("common.selected")}</span
                >
                <Button variant="secondary" size="sm" onclick={() => openAssignModal()}>
                  <Users class="w-3.5 h-3.5" />
                  {tr("academyView.assign")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onclick={() => promptDelete(Array.from(selectedIds))}
                >
                  <Trash2 class="w-3.5 h-3.5" />
                  {tr("common.delete")}
                </Button>
              </div>
            {/if}
          </div>

          <!-- Table -->
          {#if filteredCourses.length === 0}
            <div class="card p-16 text-center">
              <BookOpen class="w-10 h-10 text-kitsuden-text-dim mx-auto mb-3" />
              <p class="text-kitsuden-text-dim">{tr("academyView.noCoursesFound")}</p>
            </div>
          {:else}
            <div class="card overflow-hidden">
              <div class="overflow-x-auto">
                <Table class="w-full text-left text-sm">
                  <TableHeader class="bg-kitsuden-bg sticky top-0 z-10">
                    <TableRow class="border-b border-kitsuden-border">
                      <TableHead class="px-4 py-3 w-10">
                        <input
                          type="checkbox"
                          class="rounded-sm border-kitsuden-input bg-kitsuden-bg text-kitsuden-accent"
                          checked={allSelected}
                          indeterminate={someSelected}
                          onchange={toggleSelectAll}
                        />
                      </TableHead>
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("title")}
                        >{tr("common.title")}
                        {#if sortKey === "title"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("assignments")}
                        >{tr("academyView.assignments")}
                        {#if sortKey === "assignments"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("completedItems")}
                        >{tr("academyView.completed")}
                        {#if sortKey === "completedItems"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("averageProgress")}
                        >{tr("academyView.avgProgress")}
                        {#if sortKey === "averageProgress"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("finishRate")}
                        >{tr("academyView.completion")}
                        {#if sortKey === "finishRate"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("totalSurveys")}
                        >{tr("academyView.surveys")}
                        {#if sortKey === "totalSurveys"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead
                        class="px-4 py-3 font-medium text-kitsuden-subtle cursor-pointer select-none"
                        onclick={() => toggleSort("averageSatisfaction")}
                        >{tr("academyView.satisfaction")}
                        {#if sortKey === "averageSatisfaction"}<span class="text-kitsuden-accent"
                            >{sortDir === "asc" ? "▲" : "▼"}</span
                          >{/if}</TableHead
                      >
                      <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                        >{tr("common.actions")}</TableHead
                      >
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {#each pagedCourses as r}
                      <TableRow
                        class="border-b border-kitsuden-border hover:bg-kitsuden-bg/50 transition-colors group"
                      >
                        <TableCell class="px-4 py-3">
                          <input
                            type="checkbox"
                            class="rounded-sm border-kitsuden-input bg-kitsuden-bg text-kitsuden-accent"
                            checked={selectedIds.has(r.course.id)}
                            onchange={() => toggleSelect(r.course.id)}
                          />
                        </TableCell>
                        <TableCell class="px-4 py-3">
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-kitsuden-text">{r.course.title}</span>
                            <span
                              class="px-1.5 py-0.5 rounded text-xs font-medium {courseTypeColors[
                                r.course.type
                              ] || 'bg-kitsuden-subtle/15 text-kitsuden-text-dim'}"
                              >{courseTypeLabels[r.course.type] || r.course.type}</span
                            >
                          </div>
                        </TableCell>
                        <TableCell class="px-4 py-3 text-kitsuden-text"
                          >{r.metrics.assignments}</TableCell
                        >
                        <TableCell class="px-4 py-3 text-kitsuden-text"
                          >{r.metrics.completedItems}</TableCell
                        >
                        <TableCell class="px-4 py-3">
                          <div class="flex items-center gap-2">
                            <div class="w-16 h-1.5 bg-kitsuden-bg rounded-full overflow-hidden">
                              <div
                                class="h-full bg-kitsuden-accent rounded-full"
                                style="width: {r.metrics.averageProgress}%"
                              ></div>
                            </div>
                            <span class="text-xs text-kitsuden-subtle"
                              >{fmtPct(r.metrics.averageProgress)}</span
                            >
                          </div>
                        </TableCell>
                        <TableCell class="px-4 py-3 text-kitsuden-text"
                          >{fmtPct(r.metrics.finishRate)}</TableCell
                        >
                        <TableCell class="px-4 py-3 text-kitsuden-text"
                          >{r.metrics.totalSurveys}</TableCell
                        >
                        <TableCell class="px-4 py-3 text-kitsuden-amber text-xs"
                          >{fmtStar(r.metrics.averageSatisfaction)}</TableCell
                        >
                        <TableCell class="px-4 py-3">
                          <div
                            class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <button
                              class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent"
                              title={tr("academyView.viewStats")}
                              onclick={() => openDrawer(r)}><Eye class="w-3.5 h-3.5" /></button
                            >
                            <a
                              href="/academy/courses/{r.course.id}/edit"
                              class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
                              title={tr("common.edit")}><Edit2 class="w-3.5 h-3.5" /></a
                            >
                            <button
                              class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent-2"
                              title={tr("common.delete")}
                              onclick={() => promptDelete([r.course.id])}
                              ><Trash2 class="w-3.5 h-3.5" /></button
                            >
                          </div>
                        </TableCell>
                      </TableRow>
                    {/each}
                  </TableBody>
                </Table>
              </div>

              <!-- Pagination -->
              {#if totalPages > 1}
                <div
                  class="p-3 border-t border-kitsuden-border bg-kitsuden-card flex items-center justify-between"
                >
                  <span class="text-xs text-kitsuden-subtle"
                    >{filteredCourses.length}
                    {tr("academyView.totalPageOf", { currentPage })}
                    {totalPages}</span
                  >
                  <div class="flex items-center gap-2">
                    <button
                      class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                      disabled={currentPage === 1}
                      onclick={() => (currentPage = 1)}><ChevronFirst class="w-3.5 h-3.5" /></button
                    >
                    <button
                      class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                      disabled={currentPage === 1}
                      onclick={() => currentPage--}><ChevronLeft class="w-3.5 h-3.5" /></button
                    >
                    <span class="text-xs text-kitsuden-subtle px-2"
                      >{currentPage} / {totalPages}</span
                    >
                    <button
                      class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                      disabled={currentPage === totalPages}
                      onclick={() => currentPage++}><ChevronRight class="w-3.5 h-3.5" /></button
                    >
                    <button
                      class="px-2.5 py-1.5 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-xs hover:border-kitsuden-accent/50 disabled:opacity-40"
                      disabled={currentPage === totalPages}
                      onclick={() => (currentPage = totalPages)}
                      ><ChevronLast class="w-3.5 h-3.5" /></button
                    >
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- LEARNING PATHS TAB                                                -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
      {:else if activeTab === "paths"}
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <Table class="w-full text-left text-sm">
              <TableHeader class="bg-kitsuden-bg">
                <TableRow class="border-b border-kitsuden-border">
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.name")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.category")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.courses")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.sequentialApproval")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.actions")}</TableHead
                  >
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each learningPaths as lp}
                  <TableRow
                    class="border-b border-kitsuden-border hover:bg-kitsuden-bg/50 transition-colors"
                  >
                    <TableCell class="px-4 py-3">
                      <div class="font-medium text-kitsuden-text">{lp.name}</div>
                      {#if lp.description}<div class="text-xs text-kitsuden-subtle">
                          {lp.description}
                        </div>{/if}
                    </TableCell>
                    <TableCell class="px-4 py-3 text-kitsuden-subtle"
                      >{lp.category || "—"}</TableCell
                    >
                    <TableCell class="px-4 py-3 text-kitsuden-text">{lp.totalCourses}</TableCell>
                    <TableCell class="px-4 py-3">
                      <span
                        class="px-2 py-0.5 rounded text-xs font-medium {lp.sequential
                          ? 'bg-kitsuden-green/15 text-kitsuden-green'
                          : 'bg-kitsuden-text-dim/15 text-kitsuden-subtle'}"
                        >{lp.sequential ? tr("common.yes") : tr("common.no")}</span
                      >
                    </TableCell>
                    <TableCell class="px-4 py-3">
                      <div class="flex items-center gap-1">
                        <a
                          href="/academy/learning-paths/{lp.id}/edit"
                          class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
                          ><Edit2 class="w-3.5 h-3.5" /></a
                        >
                        <button
                          class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent-2"
                          onclick={() => deletePath(lp.id)}><Trash2 class="w-3.5 h-3.5" /></button
                        >
                      </div>
                    </TableCell>
                  </TableRow>
                {:else}
                  <TableRow
                    ><TableCell colspan={5} class="px-4 py-12 text-center text-kitsuden-text-dim"
                      ><Route class="w-8 h-8 mx-auto mb-2" />{tr(
                        "academyView.noLearningPathsFound"
                      )}</TableCell
                    ></TableRow
                  >
                {/each}
              </TableBody>
            </Table>
          </div>
        </div>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- GROUPS TAB                                                        -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
      {:else if activeTab === "groups"}
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <Table class="w-full text-left text-sm">
              <TableHeader class="bg-kitsuden-bg">
                <TableRow class="border-b border-kitsuden-border">
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.name")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.members")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.supervisor")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.actions")}</TableHead
                  >
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each groups as g}
                  <TableRow
                    class="border-b border-kitsuden-border hover:bg-kitsuden-bg/50 transition-colors"
                  >
                    <TableCell class="px-4 py-3">
                      <div class="font-medium text-kitsuden-text">{g.name}</div>
                      {#if g.description}<div class="text-xs text-kitsuden-subtle">
                          {g.description}
                        </div>{/if}
                    </TableCell>
                    <TableCell class="px-4 py-3 text-kitsuden-text">{g.members}</TableCell>
                    <TableCell class="px-4 py-3 text-kitsuden-subtle"
                      >{g.supervisorPrincipal || "—"}</TableCell
                    >
                    <TableCell class="px-4 py-3">
                      <div class="flex items-center gap-1">
                        <a
                          href="/academy/groups/{g.id}/edit"
                          class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
                          ><Edit2 class="w-3.5 h-3.5" /></a
                        >
                        <button
                          class="p-1.5 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-accent-2"
                          onclick={() => deleteGroup(g.id)}><Trash2 class="w-3.5 h-3.5" /></button
                        >
                      </div>
                    </TableCell>
                  </TableRow>
                {:else}
                  <TableRow
                    ><TableCell colspan={4} class="px-4 py-12 text-center text-kitsuden-text-dim"
                      ><Users class="w-8 h-8 mx-auto mb-2" />{tr(
                        "academyView.noGroupsFound"
                      )}</TableCell
                    ></TableRow
                  >
                {/each}
              </TableBody>
            </Table>
          </div>
        </div>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- ASSIGNMENTS TAB                                                   -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
      {:else if activeTab === "assignments"}
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <Table class="w-full text-left text-sm">
              <TableHeader class="bg-kitsuden-bg">
                <TableRow class="border-b border-kitsuden-border">
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.courseId")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.userId")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.groupId")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("academyView.method")}</TableHead
                  >
                  <TableHead class="px-4 py-3 font-medium text-kitsuden-subtle"
                    >{tr("common.date")}</TableHead
                  >
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each assignments as a}
                  <TableRow
                    class="border-b border-kitsuden-border hover:bg-kitsuden-bg/50 transition-colors"
                  >
                    <TableCell class="px-4 py-3 font-mono text-xs text-kitsuden-text"
                      >{a.courseId}</TableCell
                    >
                    <TableCell class="px-4 py-3 font-mono text-xs text-kitsuden-subtle"
                      >{a.userId || "—"}</TableCell
                    >
                    <TableCell class="px-4 py-3 font-mono text-xs text-kitsuden-subtle"
                      >{a.groupId || "—"}</TableCell
                    >
                    <TableCell class="px-4 py-3 text-kitsuden-text">{a.method || "—"}</TableCell>
                    <TableCell class="px-4 py-3 text-kitsuden-subtle"
                      >{a.date
                        ? new Date(a.date).toLocaleDateString(localeFormat())
                        : "—"}</TableCell
                    >
                  </TableRow>
                {:else}
                  <TableRow
                    ><TableCell colspan={5} class="px-4 py-12 text-center text-kitsuden-text-dim"
                      ><Layers class="w-8 h-8 mx-auto mb-2" />{tr(
                        "academyView.noAssignmentsFound"
                      )}</TableCell
                    ></TableRow
                  >
                {/each}
              </TableBody>
            </Table>
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- COURSE DETAIL DRAWER                                                  -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <Dialog
    open={!!drawerOpen}
    bare
    size="xl"
    ariaLabel={drawerCourse?.course.title || tr("academyView.course")}
    placement="right"
    onClose={() => closeDrawer()}
  >
    {#if drawerOpen}
      <div
        class="relative w-full max-w-xl bg-kitsuden-card border-l border-kitsuden-border h-full flex flex-col shadow-2xl"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between px-6 py-4 border-b border-kitsuden-border shrink-0"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              {#if drawerCourse}
                <span
                  class="px-1.5 py-0.5 rounded text-xs font-medium {courseTypeColors[
                    drawerCourse.course.type
                  ] || ''}"
                  >{courseTypeLabels[drawerCourse.course.type] || drawerCourse.course.type}</span
                >
              {/if}
            </div>
            <h2 class="text-lg font-bold text-kitsuden-text truncate">
              {drawerCourse?.course.title || tr("academyView.course")}
            </h2>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onclick={() => drawerCourse && openAssignModal([drawerCourse.course.id])}
            >
              <Users class="w-3.5 h-3.5" />
              {tr("academyView.assign")}
            </Button>
            <button
              class="p-2 hover:bg-kitsuden-bg rounded-lg text-kitsuden-text-dim hover:text-kitsuden-text"
              onclick={closeDrawer}><X class="w-5 h-5" /></button
            >
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          {#if drawerLoading}
            <div class="flex items-center justify-center h-40">
              <div
                class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
              ></div>
            </div>
          {:else if !drawerStats}
            <div class="text-center text-kitsuden-subtle py-12">
              {tr("academyView.noStatsAvailable")}
            </div>
          {:else}
            {@const s = drawerStats}
            <!-- Stats Grid -->
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
              {#each [{ label: tr("academyView.assigned"), value: s.totalAssigned, icon: Users, color: "text-kitsuden-accent" }, { label: tr("academyView.completed2"), value: s.completedItems, icon: CheckCircle, color: "text-kitsuden-green" }, { label: tr("academyView.inProgress"), value: s.inProgress, icon: TrendingUp, color: "text-kitsuden-amber" }, { label: tr("academyView.notStarted"), value: s.notStarted, icon: AlertCircle, color: "text-kitsuden-accent-2" }, { label: tr("academyView.completionRate2"), value: fmtPct(s.finishRate), icon: BarChart3, color: "text-kitsuden-green" }, { label: tr("academyView.avgProgress2"), value: fmtPct(s.averageProgress), icon: TrendingUp, color: "text-kitsuden-accent" }, { label: tr("academyView.quizPassers"), value: s.passedQuiz, icon: CheckCircle, color: "text-kitsuden-green" }, { label: tr("academyView.avgQuizScore"), value: s.averageQuizScore?.toFixed(1) ?? "—", icon: Star, color: "text-kitsuden-amber" }, { label: tr("academyView.surveys2"), value: s.totalSurveys, icon: Layers, color: "text-kitsuden-accent" }, { label: tr("academyView.satisfaction2"), value: fmtStar(s.averageSatisfaction), icon: Star, color: "text-kitsuden-amber" }, { label: tr("academyView.instructorRating"), value: s.averageExhibitor?.toFixed(1) ?? "—", icon: UserCircle, color: "text-kitsuden-purple" }] as stat}
                <div
                  class="bg-kitsuden-bg border border-kitsuden-border rounded-lg p-3 flex items-center gap-3"
                >
                  <div
                    class="w-8 h-8 rounded-lg bg-kitsuden-card flex items-center justify-center shrink-0"
                  >
                    <stat.icon class="w-4 h-4 {stat.color}" />
                  </div>
                  <div>
                    <p class="text-xs text-kitsuden-subtle">{stat.label}</p>
                    <p class="text-sm font-semibold text-kitsuden-text">{stat.value}</p>
                  </div>
                </div>
              {/each}
            </div>

            <!-- Mini Bar Chart -->
            <div class="bg-kitsuden-bg border border-kitsuden-border rounded-lg p-4">
              <h3 class="text-sm font-semibold text-kitsuden-text mb-3">
                {tr("academyView.studentDistribution")}
              </h3>
              <div class="space-y-2">
                {#each [{ label: tr("academyView.completed2"), value: s.completedItems, color: "bg-kitsuden-green" }, { label: tr("academyView.inProgress"), value: s.inProgress, color: "bg-kitsuden-amber" }, { label: tr("academyView.notStarted"), value: s.notStarted, color: "bg-kitsuden-accent-2" }] as bar}
                  {@const max = Math.max(s.totalAssigned || 1, 1)}
                  <div class="flex items-center gap-3">
                    <span class="w-20 text-xs text-kitsuden-subtle text-right">{bar.label}</span>
                    <div class="flex-1 h-3 bg-kitsuden-card rounded-full overflow-hidden">
                      <div
                        class="h-full {bar.color} rounded-full"
                        style="width: {Math.min(100, ((bar.value || 0) / max) * 100)}%"
                      ></div>
                    </div>
                    <span class="w-8 text-xs text-kitsuden-text text-right">{bar.value}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </Dialog>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- DELETE CONFIRMATION MODAL                                           -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <Dialog
    open={!!showDeleteModal}
    bare
    size="sm"
    ariaLabel={tr("academyView.deleteCourseS")}
    onClose={() => (showDeleteModal = false)}
  >
    {#if showDeleteModal}
      <div
        class="relative bg-kitsuden-card border border-kitsuden-border rounded-xl p-6 w-full max-w-sm shadow-2xl"
      >
        <h3 class="text-lg font-bold text-kitsuden-text mb-2">{tr("academyView.deleteCourseS")}</h3>
        <p class="text-sm text-kitsuden-subtle mb-4">
          {tr("academyView.thisWillPermanentlyDeleteCourse", {
            deleteTargetIdsCount: deleteTargetIds.length,
          })}
        </p>
        <div class="flex items-center justify-end gap-2">
          <Button variant="secondary" onclick={() => (showDeleteModal = false)}
            >{tr("common.cancel")}</Button
          >
          <button class="btn-danger" onclick={confirmDelete}
            ><Trash2 class="w-4 h-4" /> {tr("common.delete")}</button
          >
        </div>
      </div>
    {/if}
  </Dialog>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- ASSIGN MODAL                                                        -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <Dialog
    open={!!showAssignModal}
    bare
    ariaLabel={tr("academyView.assignCourseS", { assignCursoIdsCount: assignCourseIds.length })}
    onClose={() => (showAssignModal = false)}
  >
    {#if showAssignModal}
      <div
        class="relative bg-kitsuden-card border border-kitsuden-border rounded-xl p-6 w-full max-w-md shadow-2xl"
      >
        <h3 class="text-lg font-bold text-kitsuden-text mb-1">
          {tr("academyView.assignCourseS", { assignCursoIdsCount: assignCourseIds.length })}
        </h3>
        <p class="text-xs text-kitsuden-subtle mb-4">{tr("academyView.enterCommaSeparatedIds")}</p>
        <div class="space-y-3">
          <div>
            <label for="assignuserids" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("academyView.userIds")}</label
            >
            <input
              id="assignuserids"
              class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent/50"
              placeholder={tr("academyView.user1User2")}
              bind:value={assignUserIds}
            />
          </div>
          <div>
            <label for="assigngroupids" class="block text-xs text-kitsuden-subtle mb-1"
              >{tr("academyView.groupIds")}</label
            >
            <input
              id="assigngroupids"
              class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent/50"
              placeholder={tr("academyView.group1Group2")}
              bind:value={assignGroupIds}
            />
          </div>
        </div>
        <div class="flex items-center justify-end gap-2 mt-4">
          <button class="btn-secondary" onclick={() => (showAssignModal = false)}
            >{tr("common.cancel")}</button
          >
          <button
            class="btn-primary inline-flex items-center gap-2"
            onclick={submitAssign}
            disabled={assignLoading}
          >
            {#if assignLoading}<Loader2 class="w-4 h-4 animate-spin" />{/if}
            <Users class="w-4 h-4" />
            {tr("academyView.assign")}
          </button>
        </div>
      </div>
    {/if}
  </Dialog>
</ViewPage>

<style>
  @reference "../../style.css";

  .card {
    @apply bg-kitsuden-card border border-kitsuden-border rounded-xl;
  }
  .btn-primary {
    @apply px-4 py-2 bg-kitsuden-accent text-kitsuden-on-accent rounded-lg font-medium hover:bg-kitsuden-accent-hover transition-colors disabled:opacity-50;
  }
  .btn-secondary {
    @apply px-3 py-1.5 bg-kitsuden-surface border border-kitsuden-border rounded-lg text-kitsuden-text hover:border-kitsuden-accent/50 transition-colors;
  }
  .btn-danger {
    @apply px-3 py-1.5 bg-kitsuden-accent-2/15 text-kitsuden-accent-2 border border-kitsuden-accent-2/30 rounded-lg font-medium hover:bg-kitsuden-accent-2/25 transition-colors;
  }
</style>
