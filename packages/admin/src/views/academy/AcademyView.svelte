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
    ArrowUp,
    ArrowDown,
    ChevronLeft,
    ChevronRight,
    ChevronFirst,
    ChevronLast,
    Eye,
    Edit2,
    Trash2,
    Route,
    UserCircle,
    CheckCircle,
    AlertCircle,
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
    Alert,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    EmptyState,
    Field,
    Input,
    Progress,
    SearchInput,
    Sheet,
    Spinner,
    Tabs,
    type TabItem,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  import { academyHref } from "./links";

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

  type Tone = "info" | "purple" | "warning" | "success" | "accent-2" | "secondary";
  const courseTypeTone: Record<string, Tone> = {
    INDUCCION: "info",
    GESTION: "purple",
    TECNICO: "warning",
    HERRAMIENTAS: "success",
    DESARROLLO: "accent-2",
  };

  const tabs = [
    { key: "courses", label: tr("academyView.courses"), icon: BookOpen },
    { key: "paths", label: tr("academyView.learningPaths"), icon: Route },
    { key: "groups", label: tr("academyView.groups"), icon: Users },
    { key: "assignments", label: tr("academyView.assignments"), icon: Layers },
  ] as const;

  const tabItems: TabItem[] = tabs.map((x) => ({ id: x.key, label: x.label }));

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
</script>

{#snippet typeBadge(type: string)}
  <Badge variant={courseTypeTone[type] ?? "secondary"}>{courseTypeLabels[type] || type}</Badge>
{/snippet}

{#snippet sortHead(key: typeof sortKey, label: string)}
  <TableHead
    aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
  >
    <Button variant="ghost" size="sm" onclick={() => toggleSort(key)}>
      {label}
      {#if sortKey === key}
        {#if sortDir === "asc"}
          <ArrowUp class="w-3 h-3" aria-hidden="true" />
        {:else}
          <ArrowDown class="w-3 h-3" aria-hidden="true" />
        {/if}
      {/if}
    </Button>
  </TableHead>
{/snippet}

{#snippet statTile(Icon: typeof BookOpen, bg: string, fg: string, label: string, value: string)}
  <Card class="p-4 flex items-center gap-3 min-w-0">
    <div class="w-10 h-10 shrink-0 rounded-lg {bg} flex items-center justify-center">
      <Icon class="w-5 h-5 {fg}" />
    </div>
    <div class="min-w-0">
      <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">{label}</p>
      <p class="text-2xl font-bold text-kitsuden-text">{value}</p>
    </div>
  </Card>
{/snippet}

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!-- HEADER & STATS                                                        -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->
<ViewPage
  title={tr("academyView.academyLms")}
  description={tr("academyView.courseManagementAssignmentsAnalytics")}
>
  {#snippet actions()}
    <Button href={academyHref("grid-courses", "new")}>
      <Plus class="w-4 h-4" />
      {tr("academyView.newCourse")}
    </Button>
  {/snippet}

  <div class="space-y-6 min-w-0">
    {#if alerts.length > 0}
      <div class="space-y-2">
        {#each alerts as a}
          <Alert variant={a.type === "warning" ? "warning" : "success"}>{a.message}</Alert>
        {/each}
      </div>
    {/if}

    <!-- Stats Row -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {@render statTile(
        BookOpen,
        "bg-kitsuden-accent/15",
        "text-kitsuden-accent",
        tr("academyView.totalCourses"),
        String(metrics?.totalCourses ?? 0)
      )}
      {@render statTile(
        Users,
        "bg-kitsuden-purple/15",
        "text-kitsuden-purple",
        tr("academyView.totalAssignments"),
        String(metrics?.totalAssignments ?? 0)
      )}
      <Card class="p-4 flex items-center gap-3 min-w-0">
        <div
          class="w-10 h-10 shrink-0 rounded-lg bg-kitsuden-green/15 flex items-center justify-center"
        >
          <TrendingUp class="w-5 h-5 text-kitsuden-green" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {tr("academyView.completionRate")}
          </p>
          <div class="flex items-center gap-2 mt-1">
            <p class="text-2xl font-bold text-kitsuden-text">{fmtPct(metrics?.completionRate)}</p>
            <Progress
              class="flex-1 kitsuden-progress-quiet"
              variant="success"
              value={metrics?.completionRate ?? 0}
              label={tr("academyView.completionRate")}
            />
          </div>
        </div>
      </Card>
      <Card class="p-4 flex items-center gap-3 min-w-0">
        <div
          class="w-10 h-10 shrink-0 rounded-lg bg-kitsuden-amber/15 flex items-center justify-center"
        >
          <Star class="w-5 h-5 text-kitsuden-amber" />
        </div>
        <div class="min-w-0">
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {tr("academyView.avgSatisfaction")}
          </p>
          <p class="text-2xl font-bold text-kitsuden-text">
            {metrics?.totalSurveys
              ? ((metrics.totalFeedbacks ?? 0) / (metrics.totalSurveys || 1)).toFixed(1)
              : "—"}<span class="text-sm text-kitsuden-subtle font-normal"> /5</span>
          </p>
        </div>
      </Card>
    </div>

    <Tabs
      items={tabItems}
      value={activeTab}
      panels={false}
      ariaLabel={tr("academyView.sections")}
      onchange={(id) => {
        activeTab = id as typeof activeTab;
        selectedIds = new Set();
        currentPage = 1;
      }}
    >
      {#snippet tab(item)}
        {@const TabIcon = tabs.find((x) => x.key === item.id)?.icon}
        <span class="inline-flex items-center gap-1.5">
          {#if TabIcon}<TabIcon class="w-4 h-4" aria-hidden="true" />{/if}
          {item.label}
        </span>
      {/snippet}
    </Tabs>

    {#if loading}
      <div class="flex justify-center py-20"><Spinner /></div>
    {:else}
      <!-- ═══════════════════════════════════════════════════════════════════ -->
      <!-- COURSES TAB                                                       -->
      <!-- ═══════════════════════════════════════════════════════════════════ -->
      {#if activeTab === "courses"}
        <div class="space-y-3">
          <!-- Toolbar -->
          <div class="flex items-center gap-3 flex-wrap">
            <SearchInput
              class="flex-1 min-w-[200px] max-w-sm"
              placeholder={tr("academyView.searchCourses")}
              bind:value={searchQuery}
              oninput={() => (currentPage = 1)}
            />
            {#if selectedIds.size > 0}
              <div class="flex items-center gap-2 ml-auto flex-wrap">
                <span class="text-xs text-kitsuden-subtle"
                  >{selectedIds.size} {tr("common.selected")}</span
                >
                <Button variant="secondary" size="sm" onclick={() => openAssignModal()}>
                  <Users class="w-3.5 h-3.5" />
                  {tr("academyView.assign")}
                </Button>
                <Button
                  variant="danger-ghost"
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
            <EmptyState
              variant={searchQuery.trim() ? "no-results" : "empty"}
              title={tr("academyView.noCoursesFound")}
            />
          {:else}
            <Table aria-label={tr("academyView.courses")}>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10">
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected}
                      ariaLabel={tr("academyView.selectAll")}
                      onchange={toggleSelectAll}
                    />
                  </TableHead>
                  {@render sortHead("title", tr("common.title"))}
                  {@render sortHead("assignments", tr("academyView.assignments"))}
                  {@render sortHead("completedItems", tr("academyView.completed"))}
                  {@render sortHead("averageProgress", tr("academyView.avgProgress"))}
                  {@render sortHead("finishRate", tr("academyView.completion"))}
                  {@render sortHead("totalSurveys", tr("academyView.surveys"))}
                  {@render sortHead("averageSatisfaction", tr("academyView.satisfaction"))}
                  <TableHead>{tr("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each pagedCourses as r}
                  <TableRow>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(r.course.id)}
                        ariaLabel={tr("academyView.selectRow", { name: r.course.title })}
                        onchange={() => toggleSelect(r.course.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-kitsuden-text">{r.course.title}</span>
                        {@render typeBadge(r.course.type)}
                      </div>
                    </TableCell>
                    <TableCell>{r.metrics.assignments}</TableCell>
                    <TableCell>{r.metrics.completedItems}</TableCell>
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <Progress
                          class="w-16 kitsuden-progress-quiet"
                          value={r.metrics.averageProgress}
                          label={tr("academyView.avgProgress")}
                        />
                        <span class="text-xs text-kitsuden-subtle"
                          >{fmtPct(r.metrics.averageProgress)}</span
                        >
                      </div>
                    </TableCell>
                    <TableCell>{fmtPct(r.metrics.finishRate)}</TableCell>
                    <TableCell>{r.metrics.totalSurveys}</TableCell>
                    <TableCell class="text-kitsuden-amber text-xs"
                      >{fmtStar(r.metrics.averageSatisfaction)}</TableCell
                    >
                    <TableCell>
                      <div class="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          ariaLabel={tr("academyView.viewStats")}
                          title={tr("academyView.viewStats")}
                          onclick={() => openDrawer(r)}
                          ><Eye class="w-4 h-4" aria-hidden="true" /></Button
                        >
                        <Button
                          variant="ghost"
                          size="icon"
                          href={academyHref("grid-courses", r.course.id)}
                          ariaLabel={tr("common.edit")}
                          title={tr("common.edit")}
                          ><Edit2 class="w-4 h-4" aria-hidden="true" /></Button
                        >
                        <Button
                          variant="danger-ghost"
                          size="icon"
                          ariaLabel={tr("common.delete")}
                          title={tr("common.delete")}
                          onclick={() => promptDelete([r.course.id])}
                          ><Trash2 class="w-4 h-4" aria-hidden="true" /></Button
                        >
                      </div>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>

            <!-- Pagination -->
            {#if totalPages > 1}
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-xs text-kitsuden-subtle"
                  >{filteredCourses.length}
                  {tr("academyView.totalPageOf", { currentPage })}
                  {totalPages}</span
                >
                <div class="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="icon"
                    ariaLabel={tr("academyView.firstPage")}
                    disabled={currentPage === 1}
                    onclick={() => (currentPage = 1)}
                    ><ChevronFirst class="w-4 h-4" aria-hidden="true" /></Button
                  >
                  <Button
                    variant="secondary"
                    size="icon"
                    ariaLabel={tr("academyView.previousPage")}
                    disabled={currentPage === 1}
                    onclick={() => currentPage--}
                    ><ChevronLeft class="w-4 h-4" aria-hidden="true" /></Button
                  >
                  <span class="text-xs text-kitsuden-subtle px-2">{currentPage} / {totalPages}</span
                  >
                  <Button
                    variant="secondary"
                    size="icon"
                    ariaLabel={tr("academyView.nextPage")}
                    disabled={currentPage === totalPages}
                    onclick={() => currentPage++}
                    ><ChevronRight class="w-4 h-4" aria-hidden="true" /></Button
                  >
                  <Button
                    variant="secondary"
                    size="icon"
                    ariaLabel={tr("academyView.lastPage")}
                    disabled={currentPage === totalPages}
                    onclick={() => (currentPage = totalPages)}
                    ><ChevronLast class="w-4 h-4" aria-hidden="true" /></Button
                  >
                </div>
              </div>
            {/if}
          {/if}
        </div>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- LEARNING PATHS TAB                                                -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
      {:else if activeTab === "paths"}
        <Table aria-label={tr("academyView.learningPaths")}>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("common.name")}</TableHead>
              <TableHead>{tr("common.category")}</TableHead>
              <TableHead>{tr("academyView.courses")}</TableHead>
              <TableHead>{tr("academyView.sequentialApproval")}</TableHead>
              <TableHead>{tr("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each learningPaths as lp}
              <TableRow>
                <TableCell>
                  <div class="font-medium text-kitsuden-text">{lp.name}</div>
                  {#if lp.description}
                    <div class="text-xs text-kitsuden-subtle">{lp.description}</div>
                  {/if}
                </TableCell>
                <TableCell class="text-kitsuden-subtle">{lp.category || "—"}</TableCell>
                <TableCell>{lp.totalCourses}</TableCell>
                <TableCell>
                  <Badge variant={lp.sequential ? "success" : "secondary"}
                    >{lp.sequential ? tr("common.yes") : tr("common.no")}</Badge
                  >
                </TableCell>
                <TableCell>
                  <div class="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      href={academyHref("grid-learning-paths", lp.id)}
                      ariaLabel={tr("common.edit")}
                      title={tr("common.edit")}><Edit2 class="w-4 h-4" aria-hidden="true" /></Button
                    >
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      ariaLabel={tr("common.delete")}
                      title={tr("common.delete")}
                      onclick={() => deletePath(lp.id)}
                      ><Trash2 class="w-4 h-4" aria-hidden="true" /></Button
                    >
                  </div>
                </TableCell>
              </TableRow>
            {:else}
              <TableRow>
                <TableCell colspan={5}>
                  <EmptyState
                    size="sm"
                    level={null}
                    title={tr("academyView.noLearningPathsFound")}
                  />
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- GROUPS TAB                                                        -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
      {:else if activeTab === "groups"}
        <Table aria-label={tr("academyView.groups")}>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("common.name")}</TableHead>
              <TableHead>{tr("academyView.members")}</TableHead>
              <TableHead>{tr("academyView.supervisor")}</TableHead>
              <TableHead>{tr("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each groups as g}
              <TableRow>
                <TableCell>
                  <div class="font-medium text-kitsuden-text">{g.name}</div>
                  {#if g.description}
                    <div class="text-xs text-kitsuden-subtle">{g.description}</div>
                  {/if}
                </TableCell>
                <TableCell>{g.members}</TableCell>
                <TableCell class="text-kitsuden-subtle">{g.supervisorPrincipal || "—"}</TableCell>
                <TableCell>
                  <div class="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      href={academyHref("grid-groups", g.id)}
                      ariaLabel={tr("common.edit")}
                      title={tr("common.edit")}><Edit2 class="w-4 h-4" aria-hidden="true" /></Button
                    >
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      ariaLabel={tr("common.delete")}
                      title={tr("common.delete")}
                      onclick={() => deleteGroup(g.id)}
                      ><Trash2 class="w-4 h-4" aria-hidden="true" /></Button
                    >
                  </div>
                </TableCell>
              </TableRow>
            {:else}
              <TableRow>
                <TableCell colspan={4}>
                  <EmptyState size="sm" level={null} title={tr("academyView.noGroupsFound")} />
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- ASSIGNMENTS TAB                                                   -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
      {:else if activeTab === "assignments"}
        <Table aria-label={tr("academyView.assignments")}>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("academyView.courseId")}</TableHead>
              <TableHead>{tr("common.userId")}</TableHead>
              <TableHead>{tr("academyView.groupId")}</TableHead>
              <TableHead>{tr("academyView.method")}</TableHead>
              <TableHead>{tr("common.date")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each assignments as a}
              <TableRow>
                <TableCell class="font-mono text-xs text-kitsuden-text">{a.courseId}</TableCell>
                <TableCell class="font-mono text-xs text-kitsuden-subtle"
                  >{a.userId || "—"}</TableCell
                >
                <TableCell class="font-mono text-xs text-kitsuden-subtle"
                  >{a.groupId || "—"}</TableCell
                >
                <TableCell>{a.method || "—"}</TableCell>
                <TableCell class="text-kitsuden-subtle"
                  >{a.date ? new Date(a.date).toLocaleDateString(localeFormat()) : "—"}</TableCell
                >
              </TableRow>
            {:else}
              <TableRow>
                <TableCell colspan={5}>
                  <EmptyState size="sm" level={null} title={tr("academyView.noAssignmentsFound")} />
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    {/if}
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- COURSE DETAIL DRAWER                                                  -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <Sheet
    open={drawerOpen}
    side="right"
    size="xl"
    title={drawerCourse?.course.title || tr("academyView.course")}
    onClose={() => closeDrawer()}
  >
    {#if drawerOpen}
      <div class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-2">
          {#if drawerCourse}{@render typeBadge(drawerCourse.course.type)}{/if}
          <Button
            variant="secondary"
            size="sm"
            onclick={() => drawerCourse && openAssignModal([drawerCourse.course.id])}
          >
            <Users class="w-3.5 h-3.5" />
            {tr("academyView.assign")}
          </Button>
        </div>

        {#if drawerLoading}
          <div class="flex items-center justify-center h-40"><Spinner size="lg" /></div>
        {:else if !drawerStats}
          <EmptyState size="sm" title={tr("academyView.noStatsAvailable")} />
        {:else}
          {@const s = drawerStats}
          <!-- Stats Grid -->
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            {#each [{ label: tr("academyView.assigned"), value: s.totalAssigned, icon: Users, color: "text-kitsuden-accent" }, { label: tr("academyView.completed2"), value: s.completedItems, icon: CheckCircle, color: "text-kitsuden-green" }, { label: tr("academyView.inProgress"), value: s.inProgress, icon: TrendingUp, color: "text-kitsuden-amber" }, { label: tr("academyView.notStarted"), value: s.notStarted, icon: AlertCircle, color: "text-kitsuden-accent-2" }, { label: tr("academyView.completionRate2"), value: fmtPct(s.finishRate), icon: BarChart3, color: "text-kitsuden-green" }, { label: tr("academyView.avgProgress2"), value: fmtPct(s.averageProgress), icon: TrendingUp, color: "text-kitsuden-accent" }, { label: tr("academyView.quizPassers"), value: s.passedQuiz, icon: CheckCircle, color: "text-kitsuden-green" }, { label: tr("academyView.avgQuizScore"), value: s.averageQuizScore?.toFixed(1) ?? "—", icon: Star, color: "text-kitsuden-amber" }, { label: tr("academyView.surveys2"), value: s.totalSurveys, icon: Layers, color: "text-kitsuden-accent" }, { label: tr("academyView.satisfaction2"), value: fmtStar(s.averageSatisfaction), icon: Star, color: "text-kitsuden-amber" }, { label: tr("academyView.instructorRating"), value: s.averageExhibitor?.toFixed(1) ?? "—", icon: UserCircle, color: "text-kitsuden-purple" }] as stat}
              <Card class="p-3 flex items-center gap-3 min-w-0">
                <div
                  class="w-8 h-8 rounded-lg bg-kitsuden-card flex items-center justify-center shrink-0"
                >
                  <stat.icon class="w-4 h-4 {stat.color}" />
                </div>
                <div class="min-w-0">
                  <p class="text-xs text-kitsuden-subtle">{stat.label}</p>
                  <p class="text-sm font-semibold text-kitsuden-text">{stat.value}</p>
                </div>
              </Card>
            {/each}
          </div>

          <!-- Mini Bar Chart -->
          <Card>
            <CardHeader>
              <CardTitle>{tr("academyView.studentDistribution")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="space-y-2">
                {#each [{ label: tr("academyView.completed2"), value: s.completedItems, variant: "success" as const }, { label: tr("academyView.inProgress"), value: s.inProgress, variant: "warning" as const }, { label: tr("academyView.notStarted"), value: s.notStarted, variant: "error" as const }] as bar}
                  <div class="flex items-center gap-3">
                    <span class="w-20 text-xs text-kitsuden-subtle text-right">{bar.label}</span>
                    <Progress
                      class="flex-1 kitsuden-progress-quiet"
                      variant={bar.variant}
                      value={bar.value || 0}
                      max={Math.max(s.totalAssigned || 1, 1)}
                      label={bar.label}
                    />
                    <span class="w-8 text-xs text-kitsuden-text text-right">{bar.value}</span>
                  </div>
                {/each}
              </div>
            </CardContent>
          </Card>
        {/if}
      </div>
    {/if}
  </Sheet>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- DELETE CONFIRMATION MODAL                                           -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <Dialog
    open={showDeleteModal}
    size="sm"
    title={deleteTargetIds.length === 1
      ? tr("academyView.deleteCourseOne")
      : tr("academyView.deleteCourseMany", { n: deleteTargetIds.length })}
    description={tr("list.deleteDescription")}
    onClose={() => (showDeleteModal = false)}
  >
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showDeleteModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button variant="danger" onclick={confirmDelete}
        ><Trash2 class="w-4 h-4" /> {tr("common.delete")}</Button
      >
    {/snippet}
  </Dialog>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- ASSIGN MODAL                                                        -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <Dialog
    open={showAssignModal}
    title={assignCourseIds.length === 1
      ? tr("academyView.assignCourseOne")
      : tr("academyView.assignCourseMany", { n: assignCourseIds.length })}
    description={tr("academyView.enterCommaSeparatedIds")}
    onClose={() => (showAssignModal = false)}
  >
    <div class="space-y-3">
      <Field label={tr("academyView.userIds")}>
        <Input
          id="assignuserids"
          placeholder={tr("academyView.user1User2")}
          bind:value={assignUserIds}
        />
      </Field>
      <Field label={tr("academyView.groupIds")}>
        <Input
          id="assigngroupids"
          placeholder={tr("academyView.group1Group2")}
          bind:value={assignGroupIds}
        />
      </Field>
    </div>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showAssignModal = false)}
        >{tr("common.cancel")}</Button
      >
      <Button onclick={submitAssign} loading={assignLoading}>
        <Users class="w-4 h-4" />
        {tr("academyView.assign")}
      </Button>
    {/snippet}
  </Dialog>
</ViewPage>
