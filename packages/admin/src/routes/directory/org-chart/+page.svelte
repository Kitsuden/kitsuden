<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import {
    Avatar,
    Button,
    Card,
    CardContent,
    Dialog,
    EmptyState,
    Field,
    Input,
    SearchInput,
    Select,
    Spinner,
    toast,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { Users, ChevronDown, ChevronRight, User, Mail } from "lucide-svelte";
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

<Page
  title={t("orgChartPage.orgChart")}
  description={t("orgChartPage.hierarchicalOrganizationView")}
  crumbs={[{ label: t("orgChartPage.orgChart") }]}
>
  {#snippet actions()}
    {#if organizations.length > 0}
      <Select
        bind:value={selectedOrg}
        onchange={loadOrgChart}
        aria-label={t("orgChartPage.organization")}
        options={organizations.map((org) => ({ value: org.id, label: org.name }))}
        width="auto"
      />
    {/if}
  {/snippet}
  <div class="space-y-6">
    <!-- Search -->
    <SearchInput
      class="max-w-md"
      ariaLabel={t("orgChartPage.searchEmployee")}
      placeholder={t("orgChartPage.searchEmployee")}
      bind:value={searchQuery}
    />

    <!-- Org Chart -->
    <Card class="min-h-[500px]">
      <CardContent>
        {#if loading}
          <div class="flex items-center justify-center h-64">
            <Spinner size="lg" />
          </div>
        {:else if organizations.length === 0}
          <EmptyState
            title={t("orgChartPage.noOrganizations")}
            description={t("orgChartPage.createsAnOrganizationToSee")}
            actionLabel={t("orgChartPage.createOrganization")}
            onAction={() => {
              showCreateOrgModal = true;
              resetOrgForm();
            }}
          />
        {:else if orgData.length === 0}
          <EmptyState
            title={t("orgChartPage.noEmployees")}
            description={t("orgChartPage.theSelectedOrganizationDoesNotHave")}
          />
        {:else}
          <div class="space-y-2">
            {#each filterNodes(orgData) as root}
              {@render OrgNode({
                node: root,
                level: 0,
                expandedNodes,
                toggleNode,
                onSelect: (e: Employee) => (selectedEmployee = e),
              })}
            {/each}
          </div>
        {/if}
      </CardContent>
    </Card>

    <!-- Employee detail -->
    <Dialog
      open={selectedEmployee !== null}
      onClose={() => (selectedEmployee = null)}
      size="md"
      title={selectedEmployee
        ? selectedEmployee.displayName ||
          `${selectedEmployee.firstName} ${selectedEmployee.lastName}`
        : ""}
      description={selectedEmployee
        ? [
            selectedEmployee.positionTitle || t("orgChartPage.withoutCharge"),
            selectedEmployee.departmentName,
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined}
    >
      {#if selectedEmployee?.email}
        <Button variant="secondary" href="mailto:{selectedEmployee.email}">
          <Mail size={16} aria-hidden="true" />
          {selectedEmployee.email}
        </Button>
      {/if}
      {#snippet footer()}
        <Button variant="ghost" onclick={() => (selectedEmployee = null)}>
          {t("orgChartPage.close")}
        </Button>
        <!-- There is no page per employee: the kon's employees table is where the record is. -->
        <Button href="/g/kon-directory">{t("orgChartPage.openDirectory")}</Button>
      {/snippet}
    </Dialog>
  </div>
</Page>

<!-- Create organization -->
<Dialog bind:open={showCreateOrgModal} title={t("orgChartPage.newOrganization")} size="md">
  <form id="new-org-form" onsubmit={createOrganization}>
    <Field label={t("orgChartPage.name")} required>
      <Input bind:value={newOrgName} required placeholder={t("orgChartPage.ejAcmeCorp")} />
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (showCreateOrgModal = false)}>
      {t("common.cancel")}
    </Button>
    <Button
      type="submit"
      form="new-org-form"
      loading={savingOrg}
      disabled={savingOrg || !newOrgName.trim()}
    >
      {savingOrg ? t("orgChartPage.creating") : t("common.create")}
    </Button>
  {/snippet}
</Dialog>

<!-- Recursive Org Node Component -->
{#snippet OrgNode({
  node,
  level,
  expandedNodes,
  toggleNode,
  onSelect,
}: {
  node: Employee;
  level: number;
  expandedNodes: Set<string>;
  toggleNode: (id: string) => void;
  onSelect: (e: Employee) => void;
})}
  <div class="select-none">
    <!-- Node Card -->
    <div
      class="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 min-w-0 rounded-lg hover:bg-kitsuden-text/5 transition-colors cursor-pointer group"
      style="padding-left: {level * 16 + 8}px"
      onclick={() => onSelect(node)}
    >
      <!-- Expand/Collapse -->
      {#if node.children && node.children.length > 0}
        <Button
          variant="ghost"
          size="icon"
          ariaLabel={t("orgChartPage.toggleReports", {
            name: node.displayName || node.firstName + " " + node.lastName,
          })}
          aria-expanded={expandedNodes.has(node.id)}
          onclick={(e: MouseEvent) => {
            e.stopPropagation();
            toggleNode(node.id);
          }}
        >
          {#if expandedNodes.has(node.id)}
            <ChevronDown class="w-4 h-4 text-kitsuden-subtle" />
          {:else}
            <ChevronRight class="w-4 h-4 text-kitsuden-subtle" />
          {/if}
        </Button>
      {:else}
        <div class="w-10 shrink-0"></div>
      {/if}

      <!-- Avatar -->
      <Avatar name={node.displayName || `${node.firstName} ${node.lastName}`} decorative />

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
      <Button
        variant="ghost"
        size="icon"
        href="/directory/employees/{node.id}"
        class="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
        ariaLabel={t("orgChartPage.viewProfile", {
          name: node.displayName || node.firstName + " " + node.lastName,
        })}
        onclick={(e: MouseEvent) => e.stopPropagation()}
      >
        <User class="w-4 h-4" />
      </Button>
    </div>

    <!-- Children -->
    {#if node.children && node.children.length > 0 && expandedNodes.has(node.id)}
      <div class="relative">
        <!-- Vertical line -->
        <div
          class="absolute top-0 bottom-0 w-px bg-kitsuden-border"
          style="left: {level * 16 + 28}px"
        ></div>

        {#each node.children as child}
          {@render OrgNode({
            node: child,
            level: level + 1,
            expandedNodes,
            toggleNode,
            onSelect,
          })}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}
