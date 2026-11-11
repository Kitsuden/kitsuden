<script lang="ts">
  import { t } from "$lib/i18n";
  import { Coffee, Check, Download, Trash2 } from "lucide-svelte";

  import { currentTheme, setTheme, themes } from "$lib/theme.svelte";

  // Installing and uninstalling themes does not exist yet: the two themes ship
  // built in. The buttons were hooked to empty functions and did nothing
  // when pressed; now they appear disabled and say why.
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold text-kitsuden-text">{t("themeSelector.appearance")}</h2>
      <p class="text-sm text-kitsuden-text-dim mt-0.5">
        {t("themeSelector.customizeTheAdminPanelColors")}
      </p>
    </div>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {#each themes as theme}
      <div
        class="card p-4 relative group"
        class:border-kitsuden-accent={currentTheme() === theme.id}
      >
        {#if currentTheme() === theme.id}
          <div class="absolute top-2 right-2">
            <span
              class="px-2 py-1 text-xs font-medium bg-kitsuden-accent/10 text-kitsuden-accent rounded-full"
            >
              {t("common.active")}
            </span>
          </div>
        {/if}

        <div class="flex items-center gap-3 mb-3">
          <div
            class="w-10 h-10 rounded-lg flex items-center justify-center"
            style="background: {theme.preview}"
          >
            <Coffee class="w-5 h-5 text-kitsuden-text" />
          </div>
          <div>
            <h3 class="font-semibold text-kitsuden-text">{theme.name}</h3>
            <p class="text-xs text-kitsuden-subtle">{theme.description}</p>
          </div>
        </div>

        <div class="flex items-center gap-2 mt-4">
          {#if currentTheme() === theme.id}
            <button class="btn-secondary flex-1" disabled>
              <Check class="w-4 h-4" />
              {t("common.active")}
            </button>
          {:else}
            <button class="btn-primary flex-1" onclick={() => setTheme(theme.id)}>
              {t("common.activate")}
            </button>
          {/if}

          {#if theme.id !== "default"}
            <button
              class="p-2 rounded-lg text-kitsuden-text-dim hover:bg-kitsuden-accent-2/10 hover:text-kitsuden-accent-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              disabled
              title={t("themeSelector.seriesTopic")}
              aria-label={t("themeSelector.seriesTopic")}
            >
              <Trash2 class="w-4 h-4" />
            </button>
          {/if}
        </div>
      </div>
    {/each}

    <!-- Install new theme card -->
    <button
      class="card p-4 border-dashed border-2 border-kitsuden-border transition-colors flex flex-col items-center justify-center min-h-[160px] gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
      disabled
      title={t("themeSelector.installUnavailable")}
    >
      <div class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center">
        <Download class="w-5 h-5 text-kitsuden-accent" />
      </div>
      <div class="text-center">
        <h3 class="font-semibold text-kitsuden-text">{t("themeSelector.installTheme")}</h3>
        <p class="text-xs text-kitsuden-subtle mt-0.5">{t("themeSelector.importFromFileOrUrl")}</p>
      </div>
    </button>
  </div>
</div>
