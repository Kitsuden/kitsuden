<script lang="ts">
  import { toast } from "svelte-sonner";
  import { t } from "$lib/i18n";
  import {
    Building2,
    Users,
    ChevronDown,
    ChevronRight,
    Search,
    User,
    Mail,
    Plus,
    X,
    Loader2,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  import { api } from "$lib/api";

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    displayName?: string;
    /** Only in the card of someone who may see it: the public card has no email. */
    email?: string | null;
    photoId?: string;
    positionTitle?: string;
    departmentName?: string;
    managerId?: string | null;
    children: Employee[];
  }

  interface Organization {
    id: string;
    name: string;
    employeeCount: number;
  }

  let organizations: Organization[] = $state([]);
  let selectedOrg = $state("");
  let orgData = $state<Employee[]>([]);
  let loading = $state(true);
  let expandedNodes = $state<Set<string>>(new Set());
  let searchQuery = $state("");
  let selectedEmployee = $state<Employee | null>(null);
  let showCreateOrgModal = $state(false);
  let savingOrg = $state(false);
  let newOrgName = $state("");

  async function loadOrganizations() {
    try {
      const res = await api.getDirectoryOrganizations();
      organizations = res.docs || [];
      if (organizations.length > 0) {
        selectedOrg = organizations[0].id;
        await loadOrgChart();
      }
    } catch (e) {
      console.error("Error loading organizations:", e);
    } finally {
      // `loadOrgChart` is the only other place that clears it, and it does not run with no
      // organizations (or after an error): the spinner stayed forever and the empty state,
      // with its "create an organization" button, could never be reached.
      loading = false;
    }
  }

  async function loadOrgChart() {
    if (!selectedOrg) return;
    try {
      loading = true;
      const res = await api.getDirectoryOrgChart(selectedOrg);
      orgData = res.roots || [];
      // Expand first level by default
      orgData.forEach((node) => expandedNodes.add(node.id));
      expandedNodes = expandedNodes;
    } catch (e) {
      console.error("Error loading org chart:", e);
    } finally {
      loading = false;
    }
  }

  function toggleNode(nodeId: string) {
    if (expandedNodes.has(nodeId)) {
      expandedNodes.delete(nodeId);
    } else {
      expandedNodes.add(nodeId);
    }
    expandedNodes = expandedNodes;
  }

  function getInitials(firstName: string, lastName: string): string {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
  }

  function filterNodes(nodes: Employee[]): Employee[] {
    if (!searchQuery) return nodes;

    return nodes.filter((node) => {
      const matches =
        node.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        node.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        node.positionTitle?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        node.departmentName?.toLowerCase().includes(searchQuery.toLowerCase());

      if (matches) return true;

      // Check children
      if (node.children?.length) {
        const filteredChildren = filterNodes(node.children);
        if (filteredChildren.length > 0) {
          // Auto-expand if child matches
          expandedNodes.add(node.id);
          return true;
        }
      }

      return false;
    });
  }

  onMount(loadOrganizations);

  function resetOrgForm() {
    newOrgName = "";
  }

  async function createOrganization(e: Event) {
    e.preventDefault();
    savingOrg = true;
    try {
      await api.createDirectoryOrganization({ name: newOrgName.trim() });
      showCreateOrgModal = false;
      resetOrgForm();
      await loadOrganizations();
      if (selectedOrg) await loadOrgChart();
    } catch (err: any) {
      toast.error(err?.body?.error || t("orgChartPage.errorCreatingOrganization"));
    } finally {
      savingOrg = false;
    }
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-kitsuden-text flex items-center gap-3">
        <Building2 class="w-7 h-7 text-kitsuden-accent" />
        {t("orgChartPage.orgChart")}
      </h1>
      <p class="text-kitsuden-subtle mt-1">{t("orgChartPage.hierarchicalOrganizationView")}</p>
    </div>

    <div class="flex items-center gap-3">
      <select
        bind:value={selectedOrg}
        onchange={loadOrgChart}
        aria-label={t("orgChartPage.organization")}
        class="px-4 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-kitsuden-text focus:border-kitsuden-accent/50 focus:outline-hidden"
      >
        {#each organizations as org}
          <option value={org.id}>{org.name}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- Search -->
  <div class="card p-4">
    <div class="relative max-w-md">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle" />
      <input
        type="text"
        aria-label={t("orgChartPage.searchEmployee")}
        placeholder={t("orgChartPage.searchEmployee")}
        bind:value={searchQuery}
        class="w-full pl-10 pr-4 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-kitsuden-text placeholder:text-kitsuden-subtle focus:border-kitsuden-accent/50 focus:outline-hidden"
      />
    </div>
  </div>

  <!-- Org Chart -->
  <div class="card p-6 min-h-[500px]">
    {#if loading}
      <div class="flex items-center justify-center h-64">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-kitsuden-accent"></div>
      </div>
    {:else if organizations.length === 0}
      <div class="text-center py-12">
        <Building2 class="w-16 h-16 text-kitsuden-subtle mx-auto mb-4" />
        <h3 class="text-lg font-medium text-kitsuden-text mb-2">
          {t("orgChartPage.noOrganizations")}
        </h3>
        <p class="text-kitsuden-subtle mb-4">{t("orgChartPage.createsAnOrganizationToSee")}</p>
        <button
          class="btn btn-primary gap-2"
          onclick={() => {
            showCreateOrgModal = true;
            resetOrgForm();
          }}
        >
          <Plus class="w-4 h-4" />
          {t("orgChartPage.createOrganization")}
        </button>
      </div>
    {:else if orgData.length === 0}
      <div class="text-center py-12">
        <Users class="w-16 h-16 text-kitsuden-subtle mx-auto mb-4" />
        <h3 class="text-lg font-medium text-kitsuden-text mb-2">{t("orgChartPage.noEmployees")}</h3>
        <p class="text-kitsuden-subtle">
          {t("orgChartPage.theSelectedOrganizationDoesNotHave")}
        </p>
      </div>
    {:else}
      <div class="space-y-2">
        {#each filterNodes(orgData) as root}
          {@render OrgNode({
            node: root,
            level: 0,
            expandedNodes,
            toggleNode,
            getInitials,
            onSelect: (e: Employee) => (selectedEmployee = e),
          })}
        {/each}
      </div>
    {/if}
  </div>

  <!-- Employee Detail Modal -->
  {#if selectedEmployee}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        class="absolute inset-0 bg-black/70 backdrop-blur-xs"
        onclick={() => (selectedEmployee = null)}
      ></div>

      <div
        class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-md w-full"
      >
        <div class="p-6">
          <!-- Header -->
          <div class="flex items-start gap-4 mb-6">
            <div
              class="w-16 h-16 rounded-full bg-kitsuden-accent/20 flex items-center justify-center text-kitsuden-accent text-xl font-semibold"
            >
              {getInitials(selectedEmployee.firstName, selectedEmployee.lastName)}
            </div>
            <div class="flex-1">
              <h3 class="text-xl font-semibold text-kitsuden-text">
                {selectedEmployee.displayName ||
                  `${selectedEmployee.firstName} ${selectedEmployee.lastName}`}
              </h3>
              <p class="text-kitsuden-accent">
                {selectedEmployee.positionTitle || t("orgChartPage.withoutCharge")}
              </p>
              <p class="text-sm text-kitsuden-subtle">{selectedEmployee.departmentName || ""}</p>
            </div>
          </div>

          <!-- Contact Info -->
          <div class="space-y-3">
            {#if selectedEmployee.email}
              <a
                href="mailto:{selectedEmployee.email}"
                class="flex items-center gap-3 p-3 bg-kitsuden-bg rounded-lg hover:bg-kitsuden-text/5 transition-colors"
              >
                <Mail class="w-5 h-5 text-kitsuden-accent" />
                <span class="text-kitsuden-text">{selectedEmployee.email}</span>
              </a>
            {/if}
          </div>

          <!-- Actions -->
          <div class="flex gap-3 mt-6">
            <!-- There is no page per employee (`/directory/employees/<id>` was a 404): the
                 employees table of the kon is where the record is. -->
            <a href="/g/kon-directory" class="flex-1 btn btn-primary text-center">
              {t("orgChartPage.openDirectory")}
            </a>
            <button class="btn btn-ghost" onclick={() => (selectedEmployee = null)}>
              {t("orgChartPage.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Create Organization Modal -->
{#if showCreateOrgModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showCreateOrgModal = false)}
    ></div>
    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-md w-full mx-4"
    >
      <div class="flex items-center justify-between p-6 border-b border-kitsuden-border">
        <h3 class="text-lg font-semibold text-kitsuden-text">
          {t("orgChartPage.newOrganization")}
        </h3>
        <button
          onclick={() => (showCreateOrgModal = false)}
          aria-label={t("orgChartPage.close")}
          class="p-2 rounded-xl text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-text/5"
        >
          <X class="w-5 h-5" />
        </button>
      </div>
      <form onsubmit={createOrganization} class="p-6 space-y-4">
        <div>
          <label for="neworgname" class="block text-sm font-medium text-kitsuden-subtle mb-1.5"
            >{t("orgChartPage.name")}</label
          >
          <input
            id="neworgname"
            bind:value={newOrgName}
            type="text"
            placeholder={t("orgChartPage.ejAcmeCorp")}
            class="w-full px-4 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-kitsuden-text placeholder:text-kitsuden-subtle focus:border-kitsuden-accent/50 focus:outline-hidden"
            required
          />
        </div>
        <div class="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onclick={() => (showCreateOrgModal = false)}
            class="px-4 py-2 rounded-lg text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-text/5 transition-all"
            >{t("common.cancel")}</button
          >
          <button
            type="submit"
            disabled={savingOrg || !newOrgName.trim()}
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium bg-kitsuden-accent text-kitsuden-on-accent hover:bg-kitsuden-accent/90 transition-all disabled:opacity-50"
          >
            {#if savingOrg}
              <Loader2 class="w-4 h-4 animate-spin" />
              {t("orgChartPage.creating")}
            {:else}
              <Plus class="w-4 h-4" />
              {t("common.create")}
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Recursive Org Node Component -->
{#snippet OrgNode({
  node,
  level,
  expandedNodes,
  toggleNode,
  getInitials,
  onSelect,
}: {
  node: Employee;
  level: number;
  expandedNodes: Set<string>;
  toggleNode: (id: string) => void;
  getInitials: (f: string, l: string) => string;
  onSelect: (e: Employee) => void;
})}
  <div class="select-none">
    <!-- Node Card -->
    <div
      class="flex items-center gap-3 p-3 rounded-lg hover:bg-kitsuden-text/5 transition-colors cursor-pointer group"
      style="padding-left: {level * 24 + 12}px"
      onclick={() => onSelect(node)}
    >
      <!-- Expand/Collapse -->
      {#if node.children && node.children.length > 0}
        <button
          class="p-1 rounded-sm hover:bg-kitsuden-text/10 transition-colors"
          aria-label={t("orgChartPage.toggleReports", {
            name: node.displayName || node.firstName + " " + node.lastName,
          })}
          aria-expanded={expandedNodes.has(node.id)}
          onclick={(e) => {
            e.stopPropagation();
            toggleNode(node.id);
          }}
        >
          {#if expandedNodes.has(node.id)}
            <ChevronDown class="w-4 h-4 text-kitsuden-subtle" />
          {:else}
            <ChevronRight class="w-4 h-4 text-kitsuden-subtle" />
          {/if}
        </button>
      {:else}
        <div class="w-6"></div>
      {/if}

      <!-- Avatar -->
      <div
        class="w-10 h-10 rounded-full bg-kitsuden-accent/20 flex items-center justify-center text-kitsuden-accent text-sm font-medium"
      >
        {getInitials(node.firstName, node.lastName)}
      </div>

      <!-- Info -->
      <div class="flex-1 min-w-0">
        <p class="font-medium text-kitsuden-text truncate">
          {node.displayName || `${node.firstName} ${node.lastName}`}
        </p>
        <p class="text-sm text-kitsuden-subtle truncate">
          {node.positionTitle || t("orgChartPage.withoutCharge")}
        </p>
      </div>

      <!-- Direct Reports Count -->
      {#if node.children && node.children.length > 0}
        <div class="flex items-center gap-1 text-xs text-kitsuden-subtle">
          <Users class="w-3 h-3" />
          {node.children.length}
        </div>
      {/if}

      <!-- View Button (visible on hover) -->
      <a
        href="/directory/employees/{node.id}"
        class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-2 text-kitsuden-subtle hover:text-kitsuden-text transition-all"
        aria-label={t("orgChartPage.viewProfile", {
          name: node.displayName || node.firstName + " " + node.lastName,
        })}
        onclick={(e) => e.stopPropagation()}
      >
        <User class="w-4 h-4" />
      </a>
    </div>

    <!-- Children -->
    {#if node.children && node.children.length > 0 && expandedNodes.has(node.id)}
      <div class="relative">
        <!-- Vertical line -->
        <div
          class="absolute left-[{level * 24 + 27}px] top-0 bottom-0 w-px bg-kitsuden-border"
        ></div>

        {#each node.children as child}
          {@render OrgNode({
            node: child,
            level: level + 1,
            expandedNodes,
            toggleNode,
            getInitials,
            onSelect,
          })}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  @reference "../../../style.css";

  .card {
    @apply bg-kitsuden-card border border-kitsuden-border rounded-xl;
  }

  .btn {
    @apply inline-flex items-center justify-center px-4 py-2 rounded-lg font-medium transition-all;
  }

  .btn-primary {
    @apply bg-kitsuden-accent text-kitsuden-on-accent hover:bg-kitsuden-accent/90;
  }

  .btn-ghost {
    @apply text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-text/5;
  }
</style>
