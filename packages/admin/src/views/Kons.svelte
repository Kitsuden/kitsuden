<script lang="ts">
  import { disableKonPrompt } from "$lib/kon-disable";
  import { confirmDialog } from "$lib/confirm.svelte";
  import {
    Badge,
    Button,
    Card,
    CardContent,
    CardFooter,
    Dialog,
    Field,
    Input,
    Spinner,
    toast,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import KonIcon from "$lib/components/KonIcon.svelte";
  import { Archive, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";

  import UninstalledGrimoireCard from "$lib/components/modules/UninstalledGrimoireCard.svelte";
  import { moduleStore, type ModuleInfo, type UninstalledKon } from "$lib/states/modules.svelte";

  let toggling = $state<string | null>(null);
  let uninstalling = $state<string | null>(null);
  let recovering = $state<string | null>(null);
  let deleting = $state<string | null>(null);

  // Modal states
  let showUninstallModal = $state(false);
  let showDeleteModal = $state(false);
  let selectedModule = $state<ModuleInfo | UninstalledKon | null>(null);
  let deleteConfirmText = $state("");
  let uninstallPreserveData = $state(true);

  // Core infrastructure modules that are NOT grimoires (should not appear in list)
  const INFRASTRUCTURE_MODULES = ["media-library"];

  // Category labels for display
  const CATEGORY_LABELS: Record<string, string> = {
    core: t("kons.coreKons"),
    optional: t("kons.optionalKons"),
  };

  // Filter: hide infra modules, show everything else
  const visibleModules = $derived(
    moduleStore.modules.filter((m: ModuleInfo) => !INFRASTRUCTURE_MODULES.includes(m.key))
  );

  // Get grimoire names from modules that have grimoireId
  const grimoireNames = $derived.by(() => {
    const names: Record<string, string> = {};
    for (const mod of visibleModules) {
      if (mod.grimoireId && !names[mod.grimoireId]) {
        const name = mod.grimoireId
          .replace(/^grimoire-/, "")
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
        names[mod.grimoireId] = name;
      }
    }
    return names;
  });

  // Group by category for display
  const groupedModules = $derived.by(() => {
    const groups: Record<string, ModuleInfo[]> = {};
    for (const mod of visibleModules) {
      let cat: string;

      if (mod.category === "grimoire" && mod.grimoireId) {
        cat = `grimoire:${mod.grimoireId}`;
      } else {
        cat = mod.category || "optional";
      }

      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(mod);
    }
    return groups;
  });

  function getCategoryLabel(category: string): string {
    if (category.startsWith("grimoire:")) {
      const grimoireId = category.replace("grimoire:", "");
      const names = grimoireNames;
      return names[grimoireId] || grimoireId.replace(/^grimoire-/, "").replace(/-/g, " ");
    }
    return CATEGORY_LABELS[category] || category;
  }

  onMount(async () => {
    if (moduleStore.modules.length === 0) {
      await moduleStore.fetchModules();
    }
  });

  async function toggleModule(mod: ModuleInfo) {
    if (!mod.canToggle) return;
    // Disabling asks first and names what goes away; enabling is harmless and does not.
    const wasEnabled = mod.enabled;
    if (wasEnabled && !(await confirmDialog(disableKonPrompt(mod, moduleStore.modules)))) return;
    toggling = mod.key;
    const ok = await moduleStore.toggleModule(mod.key);
    toggling = null;
    // The store reports a failure itself (it knows the missing tables and the hint).
    if (ok) {
      toast.success(t(wasEnabled ? "kons.disabledToast" : "kons.enabledToast", { name: mod.name }));
    }
  }

  function openUninstallModal(mod: ModuleInfo) {
    selectedModule = mod;
    uninstallPreserveData = true;
    showUninstallModal = true;
  }

  async function confirmUninstall() {
    if (!selectedModule) return;
    showUninstallModal = false;
    uninstalling = selectedModule.key;
    await moduleStore.uninstallModule(selectedModule.key);
    uninstalling = null;
    selectedModule = null;
  }

  async function handleRecover(kon: UninstalledKon) {
    recovering = kon.key;
    await moduleStore.recoverModule(kon.key);
    recovering = null;
  }

  function openDeleteModal(kon: UninstalledKon) {
    selectedModule = kon;
    deleteConfirmText = "";
    showDeleteModal = true;
  }

  async function confirmDelete() {
    if (!selectedModule || deleteConfirmText !== selectedModule.key.replace(/^grimoire-/, ""))
      return;
    showDeleteModal = false;
    deleting = selectedModule.key;
    await moduleStore.deleteModule(selectedModule.key, true); // purge = true
    deleting = null;
    selectedModule = null;
    deleteConfirmText = "";
  }

  function formatNumber(num: number): string {
    if (num >= 1000) return (num / 1000).toFixed(1) + "k";
    return num.toString();
  }
</script>

<div class="kons">
  {#if moduleStore.loading}
    <Card>
      <CardContent class="kons-loading">
        <Spinner size="lg" label={t("kons.loadingKons")} />
        <p>{t("kons.loadingKons")}</p>
      </CardContent>
    </Card>
  {:else}
    <!-- Installed Kons -->
    {@const groups = groupedModules}
    {#each Object.entries(groups) as [category, mods]}
      <section class="kons-group">
        <div class="kons-group-head">
          <h2>{getCategoryLabel(category)}</h2>
          <Badge variant="secondary">{mods.length}</Badge>
        </div>
        <div class="kons-grid">
          {#each mods as mod}
            <Card class={mod.enabled ? "kon-card kon-card--on" : "kon-card"}>
              <CardContent class="kon-card-body">
                <div class="kon-card-head">
                  <!--
                    `mod.icon` is the NAME of a lucide icon ("Gamepad2",
                    "FileText"…), not an emoji: see KonIcon.
                  -->
                  <div class="kon-card-icon" aria-hidden="true">
                    <KonIcon name={mod.icon} size={20} />
                  </div>
                  <div class="kon-card-title">
                    <h3>{mod.name}</h3>
                    <p>{getCategoryLabel(mod.category)}</p>
                  </div>
                  <Badge variant={mod.enabled ? "success" : "default"} dot>
                    {mod.enabled ? t("kons.statusEnabled") : t("kons.statusDisabled")}
                  </Badge>
                </div>
                {#if (mod.maturity && mod.maturity !== "stable") || mod.enabledByGrimoire}
                  <div class="kon-card-tags">
                    {#if mod.maturity && mod.maturity !== "stable"}
                      <Badge
                        variant={mod.maturity === "experimental" ? "error" : "warning"}
                        title={mod.maturity === "experimental"
                          ? t("kons.experimentalNotUsedEndTo")
                          : t("kons.betaUsedButWithGaps")}
                      >
                        {mod.maturity === "experimental" ? t("kons.experimental") : t("kons.beta")}
                      </Badge>
                    {/if}
                    {#if mod.enabledByGrimoire}
                      <Badge variant="accent">{t("kons.activeByGrimoire")}</Badge>
                    {/if}
                  </div>
                {/if}
                <p class="kon-card-desc">{mod.description}</p>
              </CardContent>

              <!-- Enabling is the primary move; disabling and uninstalling stay quiet. -->
              <CardFooter class="kon-card-actions">
                {#if mod.canToggle !== false}
                  <Button
                    variant={mod.enabled ? "danger-ghost" : "primary"}
                    size="sm"
                    loading={toggling === mod.key}
                    disabled={toggling === mod.key}
                    onclick={() => toggleModule(mod)}
                  >
                    {#if toggling === mod.key}
                      {t("kons.toggling")}
                    {:else}
                      {mod.enabled ? t("kons.disable") : t("kons.enable")}
                    {/if}
                  </Button>
                {:else}
                  <p class="kon-card-note">
                    {mod.isGrimoireActive
                      ? t("kons.controlledByActiveGrimoire")
                      : t("kons.cannotBeToggled")}
                  </p>
                {/if}

                <Button
                  variant="ghost"
                  size="sm"
                  loading={uninstalling === mod.key}
                  disabled={uninstalling === mod.key}
                  onclick={() => openUninstallModal(mod)}
                >
                  {#if uninstalling === mod.key}
                    {t("kons.uninstalling")}
                  {:else}
                    <Archive size={14} aria-hidden="true" />
                    {t("kons.uninstallPreserveData")}
                  {/if}
                </Button>
              </CardFooter>
            </Card>
          {/each}
        </div>
      </section>
    {/each}

    <!-- Uninstalled Kons Section -->
    {#if moduleStore.uninstalled.length > 0}
      <section class="kons-group kons-group--uninstalled">
        <div class="kons-group-head">
          <Archive size={16} aria-hidden="true" />
          <h2>{t("kons.uninstalledKonsDataPreserved")}</h2>
          <Badge variant="secondary">{moduleStore.uninstalled.length}</Badge>
        </div>
        <p class="kons-group-note">{t("kons.theseKonsHaveBeenUninstalled")}</p>
        <div class="kons-grid">
          {#each moduleStore.uninstalled as kon}
            <UninstalledGrimoireCard
              {kon}
              recovering={recovering === kon.key}
              deleting={deleting === kon.key}
              onRecover={() => handleRecover(kon)}
              onDelete={() => openDeleteModal(kon)}
            />
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

<!-- Uninstall: the kon goes, its data stays. -->
<Dialog
  open={showUninstallModal && selectedModule !== null}
  title={selectedModule ? t("kons.uninstall", { name: selectedModule.name }) : ""}
  description={t("kons.thisActionCanBeReversed")}
  size="md"
  onClose={() => {
    showUninstallModal = false;
    selectedModule = null;
  }}
>
  {#if selectedModule}
    <div class="bg-kitsuden-surface/50 rounded-lg p-4 mb-4">
      <p class="text-sm text-kitsuden-text-dim mb-2">
        {t("kons.thisWillRemoveTheKon")}
        <strong class="text-kitsuden-accent">{t("kons.preserveAllYourData")}</strong>
        {t("kons.forFutureRecovery")}
      </p>

      {#if "tables" in selectedModule && selectedModule.tables}
        <div class="mt-3 pt-3 border-t border-kitsuden-border/50">
          <p class="text-xs text-kitsuden-subtle mb-1">{t("kons.tablesThatWillBePreserved")}</p>
          <div class="flex flex-wrap gap-1">
            {#each selectedModule.tables.slice(0, 5) as table}
              <span
                class="text-xs px-1.5 py-0.5 rounded-sm bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text-dim font-mono"
                >{table}</span
              >
            {/each}
            {#if selectedModule.tables.length > 5}
              <span
                class="text-xs px-1.5 py-0.5 rounded-sm bg-kitsuden-bg border border-kitsuden-border text-kitsuden-subtle"
                >{t("common.more", { v: selectedModule.tables.length - 5 })}</span
              >
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    <Button
      variant="ghost"
      onclick={() => {
        showUninstallModal = false;
        selectedModule = null;
      }}
    >
      {t("common.cancel")}
    </Button>
    <Button onclick={confirmUninstall}>{t("kons.uninstallPreserveData2")}</Button>
  {/snippet}
</Dialog>

<!-- Delete for good: asks for the kon's name before it can be pressed. -->
<Dialog
  open={showDeleteModal && selectedModule !== null}
  title={t("kons.deleteKonDataPermanently")}
  description={t("kons.thisActionCannotBeUndone")}
  size="md"
  onClose={() => {
    showDeleteModal = false;
    selectedModule = null;
    deleteConfirmText = "";
  }}
>
  {#if selectedModule}
    <div class="bg-kitsuden-accent-2/5 rounded-lg p-4 mb-4 border border-kitsuden-accent-2/20">
      <p class="text-sm text-kitsuden-text-dim mb-2">
        {t("kons.youAreAboutTo")}
        <strong class="text-kitsuden-accent-2">{t("kons.permanentlyDelete")}</strong>
        {t("kons.allDataFor")}
      </p>
      <p class="font-semibold text-kitsuden-text">{selectedModule.name}</p>

      {#if "dataSummary" in selectedModule && selectedModule.dataSummary}
        <div class="mt-3 pt-3 border-t border-kitsuden-accent-2/20">
          <p class="text-xs text-kitsuden-accent-2 mb-1 flex items-center gap-1">
            <Trash2 class="w-3 h-3" />
            {t("kons.thisWillDelete")}
          </p>
          <ul class="text-xs text-kitsuden-text-dim space-y-1">
            {#each selectedModule.dataSummary.tables.slice(0, 4) as table}
              <li>{t("kons.tableRows", { name: table.name, v: formatNumber(table.rows) })}</li>
            {/each}
            {#if selectedModule.dataSummary.tables.length > 4}
              <li>{t("kons.moreTables", { v: selectedModule.dataSummary.tables.length - 4 })}</li>
            {/if}
          </ul>
        </div>
      {/if}
    </div>
    <Field label={t("kons.typeToConfirm", { name: selectedModule.key.replace(/^grimoire-/, "") })}>
      <Input
        bind:value={deleteConfirmText}
        placeholder={selectedModule.key.replace(/^grimoire-/, "")}
        autocomplete="off"
      />
    </Field>
  {/if}
  {#snippet footer()}
    <Button
      variant="ghost"
      onclick={() => {
        showDeleteModal = false;
        selectedModule = null;
        deleteConfirmText = "";
      }}
    >
      {t("common.cancel")}
    </Button>
    <Button
      variant="danger"
      disabled={!selectedModule ||
        deleteConfirmText !== selectedModule.key.replace(/^grimoire-/, "")}
      onclick={confirmDelete}
    >
      {t("kons.deleteForever")}
    </Button>
  {/snippet}
</Dialog>

<style>
  .kons {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    min-width: 0;
  }
  :global(.kons-loading) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding-block: 3rem;
    color: rgb(var(--ta-text-dim));
  }
  :global(.kons-loading p) {
    margin: 0;
  }
  .kons-group-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .kons-group-head h2 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .kons-group--uninstalled {
    padding-top: 1.5rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
  .kons-group-note {
    margin: -0.25rem 0 1rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
  .kons-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
    gap: 1rem;
  }
  :global(.kon-card) {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  :global(.kon-card--on) {
    border-color: rgb(var(--ta-accent) / 0.45);
  }
  :global(.kon-card-body) {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .kon-card-head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    min-width: 0;
  }
  .kon-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--ta-radius-lg);
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-accent));
  }
  .kon-card-title {
    flex: 1;
    min-width: 0;
  }
  .kon-card-title h3 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .kon-card-title p {
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .kon-card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .kon-card-desc {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
  :global(.ta-card-footer.kon-card-actions) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .kon-card-note {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
