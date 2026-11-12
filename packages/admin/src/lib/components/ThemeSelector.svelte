<script lang="ts">
  import { t } from "$lib/i18n";
  import { Coffee, Check, Download, Trash2 } from "lucide-svelte";

  import { Badge, Button, Card } from "$lib/tallao";
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
      {@const active = currentTheme() === theme.id}
      <Card class={active ? "p-4 border-kitsuden-accent!" : "p-4"}>
        <div class="flex items-start gap-3 mb-3">
          <div
            class="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center"
            style="background: {theme.preview}"
          >
            <Coffee class="w-5 h-5 text-kitsuden-text" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="font-semibold text-kitsuden-text">{theme.name}</h3>
            <p class="text-xs text-kitsuden-subtle">{theme.description}</p>
          </div>
          {#if active}
            <Badge variant="accent">{t("common.active")}</Badge>
          {/if}
        </div>

        <div class="flex items-center gap-2 mt-4">
          {#if active}
            <Button variant="secondary" class="flex-1" disabled>
              <Check class="w-4 h-4" aria-hidden="true" />
              {t("common.active")}
            </Button>
          {:else}
            <Button class="flex-1" onclick={() => setTheme(theme.id)}>
              {t("common.activate")}
            </Button>
          {/if}

          {#if theme.id !== "default"}
            <Button
              variant="danger-ghost"
              size="icon"
              disabled
              title={t("themeSelector.seriesTopic")}
              ariaLabel={t("themeSelector.seriesTopic")}
            >
              <Trash2 class="w-4 h-4" aria-hidden="true" />
            </Button>
          {/if}
        </div>
      </Card>
    {/each}

    <!-- Install new theme card -->
    <!-- Not a control yet: installing themes does not exist, so it is a note, not a button. -->
    <div
      class="rounded-xl p-4 border-dashed border-2 border-kitsuden-border flex flex-col items-center justify-center min-h-[160px] gap-3 opacity-60"
      title={t("themeSelector.installUnavailable")}
    >
      <div class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center">
        <Download class="w-5 h-5 text-kitsuden-accent" />
      </div>
      <div class="text-center">
        <h3 class="font-semibold text-kitsuden-text">{t("themeSelector.installTheme")}</h3>
        <p class="text-xs text-kitsuden-subtle mt-0.5">{t("themeSelector.importFromFileOrUrl")}</p>
      </div>
    </div>
  </div>
</div>
