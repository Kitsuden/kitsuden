<script lang="ts">
  import { t } from "$lib/i18n";
  import KonIcon from "$lib/components/KonIcon.svelte";
  import {
    Puzzle,
    CheckCircle,
    XCircle,
    Loader2,
    Archive,
    Trash2,
    AlertTriangle,
  } from "lucide-svelte";
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
    toggling = mod.key;
    await moduleStore.toggleModule(mod.key);
    toggling = null;
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

<div class="space-y-6 animate-fade-in">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-gradient-to-br from-kitsuden-amber/20 to-kitsuden-accent-2/20 border border-kitsuden-amber/20 flex items-center justify-center"
        >
          <Puzzle class="w-5 h-5 text-kitsuden-amber" />
        </div>
        {t("kons.kons")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("kons.manageSystemKonsUninstallTo")}
      </p>
    </div>
  </div>

  {#if moduleStore.loading}
    <div class="card p-12 text-center">
      <div
        class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin mx-auto mb-4"
      ></div>
      <p class="text-kitsuden-subtle">{t("kons.loadingKons")}</p>
    </div>
  {:else}
    <!-- Installed Kons -->
    {@const groups = groupedModules}
    {#each Object.entries(groups) as [category, mods]}
      <div>
        <div class="flex items-center gap-2 mb-3">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-kitsuden-subtle">
            {getCategoryLabel(category)}
          </h2>
          <span
            class="text-[10px] px-2 py-0.5 rounded-full bg-kitsuden-surface text-kitsuden-text-dim"
          >
            {mods.length}
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {#each mods as mod}
            <div
              class="card p-5 relative"
              class:border-kitsuden-accent={mod.enabled}
              class:border={mod.enabled}
            >
              <div class="flex items-start justify-between mb-4">
                <div class="flex items-center gap-3">
                  <!--
                    `mod.icon` is the NAME of a lucide icon ("Gamepad2",
                    "FileText"…), not an emoji. Rendering it directly showed
                    that word as text, overflowing the card on the
                    left and overlapping the kon's name.
                  -->
                  <div
                    class="w-10 h-10 shrink-0 rounded-lg bg-kitsuden-surface flex items-center justify-center text-kitsuden-accent"
                  >
                    <KonIcon name={mod.icon} size={20} />
                  </div>
                  <div>
                    <h3 class="font-semibold text-kitsuden-text">{mod.name}</h3>
                    <p
                      class="text-[10px] font-medium uppercase tracking-wider text-kitsuden-subtle"
                    >
                      {getCategoryLabel(mod.category)}
                    </p>
                    {#if mod.maturity && mod.maturity !== "stable"}
                      <span
                        class="text-[9px] px-1.5 py-0.5 rounded-full border mt-1 mr-1 inline-block {mod.maturity ===
                        'experimental'
                          ? 'bg-red-500/10 text-red-400 border-red-500/20'
                          : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}"
                        title={mod.maturity === "experimental"
                          ? t("kons.experimentalNotUsedEndTo")
                          : t("kons.betaUsedButWithGaps")}
                      >
                        {mod.maturity === "experimental" ? t("kons.experimental") : t("kons.beta")}
                      </span>
                    {/if}
                    {#if mod.enabledByGrimoire}
                      <span
                        class="text-[9px] px-1.5 py-0.5 rounded-full bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/20 mt-1 inline-block"
                      >
                        {t("kons.activeByGrimoire")}
                      </span>
                    {/if}
                  </div>
                </div>
                {#if mod.enabled}
                  <CheckCircle class="w-5 h-5 text-kitsuden-accent" />
                {:else}
                  <XCircle class="w-5 h-5 text-kitsuden-subtle" />
                {/if}
              </div>
              <p class="text-sm text-kitsuden-text-dim mb-4">{mod.description}</p>

              <!-- Actions -->
              <div class="pt-3 border-t border-kitsuden-border space-y-2">
                <!-- Enable/Disable Toggle -->
                {#if mod.canToggle !== false}
                  <button
                    class="w-full text-sm font-medium px-3 py-2 rounded-lg transition-colors {mod.enabled
                      ? 'bg-kitsuden-accent-2/10 text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/20 border border-kitsuden-accent-2/20'
                      : 'bg-kitsuden-accent/10 text-kitsuden-accent hover:bg-kitsuden-accent/20 border border-kitsuden-accent/20'}"
                    disabled={toggling === mod.key}
                    onclick={() => toggleModule(mod)}
                  >
                    {#if toggling === mod.key}
                      <Loader2 class="w-4 h-4 animate-spin inline mr-1" /> {t("kons.toggling")}
                    {:else}
                      {mod.enabled ? t("kons.disable") : t("kons.enable")}
                    {/if}
                  </button>
                {:else}
                  <p class="text-xs text-kitsuden-subtle text-center py-2">
                    {mod.isGrimoireActive
                      ? t("kons.controlledByActiveGrimoire")
                      : t("kons.cannotBeToggled")}
                  </p>
                {/if}

                <!-- Uninstall Button -->
                <button
                  class="w-full text-xs font-medium px-3 py-2 rounded-lg transition-colors bg-kitsuden-subtle/10 text-kitsuden-subtle hover:bg-kitsuden-subtle/20 border border-kitsuden-border/50 flex items-center justify-center gap-1.5"
                  disabled={uninstalling === mod.key}
                  onclick={() => openUninstallModal(mod)}
                >
                  {#if uninstalling === mod.key}
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    {t("kons.uninstalling")}
                  {:else}
                    <Archive class="w-3.5 h-3.5" />
                    {t("kons.uninstallPreserveData")}
                  {/if}
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/each}

    <!-- Uninstalled Kons Section -->
    {#if moduleStore.uninstalled.length > 0}
      <div class="pt-6 border-t border-kitsuden-border">
        <div class="flex items-center gap-2 mb-3">
          <Archive class="w-4 h-4 text-kitsuden-subtle" />
          <h2 class="text-sm font-semibold uppercase tracking-wider text-kitsuden-subtle">
            {t("kons.uninstalledKonsDataPreserved")}
          </h2>
          <span
            class="text-[10px] px-2 py-0.5 rounded-full bg-kitsuden-surface text-kitsuden-text-dim"
          >
            {moduleStore.uninstalled.length}
          </span>
        </div>
        <p class="text-xs text-kitsuden-subtle mb-4">
          {t("kons.theseKonsHaveBeenUninstalled")}
        </p>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
      </div>
    {/if}
  {/if}
</div>

<!-- Uninstall Confirmation Modal -->
{#if showUninstallModal && selectedModule}
  <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
    <div class="card p-6 max-w-md w-full animate-fade-in">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-xl bg-kitsuden-amber/10 flex items-center justify-center">
          <Archive class="w-5 h-5 text-kitsuden-amber" />
        </div>
        <div>
          <h3 class="font-semibold text-kitsuden-text">
            {t("kons.uninstall", { name: selectedModule.name })}
          </h3>
          <p class="text-xs text-kitsuden-subtle">{t("kons.thisActionCanBeReversed")}</p>
        </div>
      </div>

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
                  class="text-[10px] px-1.5 py-0.5 rounded bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text-dim font-mono"
                  >{table}</span
                >
              {/each}
              {#if selectedModule.tables.length > 5}
                <span
                  class="text-[10px] px-1.5 py-0.5 rounded bg-kitsuden-bg border border-kitsuden-border text-kitsuden-subtle"
                  >{t("common.more", { v: selectedModule.tables.length - 5 })}</span
                >
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <div class="flex gap-2">
        <button
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg transition-colors bg-kitsuden-surface text-kitsuden-text hover:bg-kitsuden-border"
          onclick={() => {
            showUninstallModal = false;
            selectedModule = null;
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg transition-colors bg-kitsuden-amber/10 text-kitsuden-amber hover:bg-kitsuden-amber/20 border border-kitsuden-amber/20"
          onclick={confirmUninstall}
        >
          {t("kons.uninstallPreserveData2")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete Confirmation Modal -->
{#if showDeleteModal && selectedModule}
  <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
    <div class="card p-6 max-w-md w-full animate-fade-in border-kitsuden-accent-2/30">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-xl bg-kitsuden-accent-2/10 flex items-center justify-center">
          <AlertTriangle class="w-5 h-5 text-kitsuden-accent-2" />
        </div>
        <div>
          <h3 class="font-semibold text-kitsuden-text">{t("kons.deleteKonDataPermanently")}</h3>
          <p class="text-xs text-kitsuden-accent-2">{t("kons.thisActionCannotBeUndone")}</p>
        </div>
      </div>

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

      <div class="mb-4">
        <label for="deleteconfirmtext" class="text-xs text-kitsuden-subtle mb-1 block">
          {t("kons.type")}<strong>{selectedModule.key.replace(/^grimoire-/, "")}</strong>{t(
            "kons.toConfirm"
          )}
        </label>
        <input
          id="deleteconfirmtext"
          type="text"
          bind:value={deleteConfirmText}
          class="w-full px-3 py-2 rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text text-sm focus:outline-none focus:border-kitsuden-accent-2"
          placeholder={selectedModule.key.replace(/^grimoire-/, "")}
        />
      </div>

      <div class="flex gap-2">
        <button
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg transition-colors bg-kitsuden-surface text-kitsuden-text hover:bg-kitsuden-border"
          onclick={() => {
            showDeleteModal = false;
            selectedModule = null;
            deleteConfirmText = "";
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          class="flex-1 text-sm font-medium px-4 py-2 rounded-lg transition-colors bg-kitsuden-accent-2/10 text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/20 border border-kitsuden-accent-2/20 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={deleteConfirmText !== selectedModule.key.replace(/^grimoire-/, "")}
          onclick={confirmDelete}
        >
          {t("kons.deleteForever")}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .card {
    @apply rounded-xl border border-kitsuden-border bg-kitsuden-card;
  }

  .animate-fade-in {
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
