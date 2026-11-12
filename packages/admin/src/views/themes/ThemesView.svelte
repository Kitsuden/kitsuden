<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { t as tr } from "$lib/i18n";
  import { Palette, Check, Download, Trash2, Eye, Upload, AlertCircle } from "lucide-svelte";
  import { Alert, Badge, Button, Card, Dialog, Textarea, toast } from "$lib/tallao";

  import { currentTheme, setTheme, themes as builtinThemes } from "$lib/theme.svelte";

  interface ThemeConfig {
    id: string;
    name: string;
    description: string;
    preview: string;
    primary?: string;
    secondary?: string;
    accent?: string;
    cssVars?: Record<string, string>;
  }

  let customThemes = $state<ThemeConfig[]>([]);
  let showImportModal = $state(false);
  let jsonInput = $state("");
  let jsonError = $state("");

  const allThemes = $derived([...builtinThemes, ...customThemes]);

  function handleActivate(id: string) {
    setTheme(id);
    toast.success(tr("themesView.themeActivated"));
  }

  function handleDelete(theme: ThemeConfig) {
    if (theme.id === currentTheme()) {
      toast.error(tr("themesView.cannotDeleteTheActiveTheme"));
      return;
    }
    customThemes = customThemes.filter((t) => t.id !== theme.id);
    toast.success(tr("themesView.themeDeleted"));
  }

  function validateJson() {
    jsonError = "";
    if (!jsonInput.trim()) {
      jsonError = tr("themesView.pasteThemeJsonFirst");
      return false;
    }
    try {
      const parsed = JSON.parse(jsonInput);
      if (!parsed.id || !parsed.name || !parsed.preview) {
        jsonError = tr("themesView.themeMustHaveIdName");
        return false;
      }
      return true;
    } catch {
      jsonError = tr("themesView.invalidJson");
      return false;
    }
  }

  function importTheme() {
    if (!validateJson()) return;
    try {
      const parsed = JSON.parse(jsonInput) as ThemeConfig;
      if (allThemes.some((t) => t.id === parsed.id)) {
        jsonError = tr("themesView.aThemeWithIdAlready", { id: parsed.id });
        return;
      }
      customThemes = [...customThemes, parsed];
      jsonInput = "";
      jsonError = "";
      showImportModal = false;
      toast.success(tr("themesView.themeImported", { name: parsed.name }));
    } catch {
      jsonError = tr("themesView.failedToImportTheme");
    }
  }

  // Reactive CSS variable inspector
  let cssVarEntries = $state<{ key: string; value: string }[]>([]);

  $effect(() => {
    const _ = currentTheme(); // dependency
    const root = getComputedStyle(document.documentElement);
    const theme = allThemes.find((t) => t.id === currentTheme());
    const keys = theme?.cssVars ? Object.keys(theme.cssVars) : [];
    cssVarEntries = keys.map((key) => ({
      key,
      value: root.getPropertyValue(key).trim(),
    }));
  });
</script>

<ViewPage
  title={tr("themesView.themes")}
  description={tr("themesView.customizeAppearancePreviewChanges")}
>
  <div class="space-y-6">
    <!-- Main Layout -->
    <div class="flex flex-col lg:flex-row gap-6">
      <!-- Left: Theme Cards -->
      <div class="lg:w-[60%] space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          {#each allThemes as theme (theme.id)}
            {@const active = currentTheme() === theme.id}
            <Card class={active ? "p-4 border-kitsuden-accent!" : "p-4"}>
              <div class="flex items-start gap-3 mb-3">
                <div
                  class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style="background: {theme.preview}"
                >
                  <Palette class="w-5 h-5 text-kitsuden-text" aria-hidden="true" />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 class="font-semibold text-kitsuden-text truncate">{theme.name}</h3>
                  <p class="text-xs text-kitsuden-subtle">{theme.description}</p>
                </div>
                {#if active}
                  <Badge variant="accent">{tr("common.active")}</Badge>
                {/if}
              </div>

              <div class="flex items-center gap-2 mt-4">
                {#if active}
                  <Button variant="secondary" class="flex-1" disabled>
                    <Check class="w-4 h-4" />
                    {tr("common.active")}
                  </Button>
                {:else}
                  <Button class="flex-1" onclick={() => handleActivate(theme.id)}>
                    {tr("common.activate")}
                  </Button>
                {/if}

                {#if !builtinThemes.some((t) => t.id === theme.id)}
                  <Button
                    variant="danger-ghost"
                    size="icon"
                    onclick={() => handleDelete(theme)}
                    title={tr("themesView.deleteTheme")}
                    ariaLabel={tr("themesView.deleteTheme")}
                  >
                    <Trash2 class="w-4 h-4" aria-hidden="true" />
                  </Button>
                {/if}
              </div>
            </Card>
          {/each}

          <!-- Install New Theme Card -->
          <!-- The whole dashed tile is the control: a card-sized button the kit has no part for. -->
          <button
            type="button"
            class="rounded-xl bg-kitsuden-card p-4 border-dashed border-2 border-kitsuden-border hover:border-kitsuden-accent/50 transition-colors flex flex-col items-center justify-center min-h-[160px] gap-3"
            onclick={() => {
              showImportModal = true;
              jsonInput = "";
              jsonError = "";
            }}
          >
            <div class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center">
              <Download class="w-5 h-5 text-kitsuden-accent" />
            </div>
            <div class="text-center">
              <h3 class="font-semibold text-kitsuden-text">{tr("themesView.installNewTheme")}</h3>
              <p class="text-xs text-kitsuden-subtle mt-0.5">
                {tr("themesView.pasteJsonToImport")}
              </p>
            </div>
          </button>
        </div>
      </div>

      <!-- Right: Live Preview Panel -->
      <div class="lg:w-[40%] space-y-4">
        <Card class="p-5 lg:sticky lg:top-4">
          <div class="flex items-center gap-2 mb-4">
            <Eye class="w-5 h-5 text-kitsuden-accent" />
            <h2 class="text-lg font-semibold text-kitsuden-text">{tr("themesView.livePreview")}</h2>
          </div>

          <!-- Mini UI Mockup -->
          <div
            class="rounded-lg border overflow-hidden mb-5"
            style="background: rgb(var(--kitsuden-bg)); border-color: rgb(var(--kitsuden-border));"
          >
            <!-- Mock header -->
            <div
              class="px-4 py-3 flex items-center justify-between border-b"
              style="background: rgb(var(--kitsuden-surface)); border-color: rgb(var(--kitsuden-border));"
            >
              <div class="flex items-center gap-2">
                <div
                  class="w-6 h-6 rounded-sm"
                  style="background: rgb(var(--kitsuden-primary));"
                ></div>
                <span class="text-sm font-medium" style="color: rgb(var(--kitsuden-text));"
                  >{tr("common.dashboard")}</span
                >
              </div>
              <div class="flex gap-1.5">
                <div
                  class="w-2 h-2 rounded-full"
                  style="background: rgb(var(--kitsuden-muted));"
                ></div>
                <div
                  class="w-2 h-2 rounded-full"
                  style="background: rgb(var(--kitsuden-muted));"
                ></div>
              </div>
            </div>

            <!-- Mock body -->
            <div class="p-4 space-y-3">
              <div
                class="rounded-md p-3 border space-y-2"
                style="background: rgb(var(--kitsuden-card)); border-color: rgb(var(--kitsuden-border)); color: rgb(var(--kitsuden-text));"
              >
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium">{tr("themesView.overview")}</span>
                  <span
                    class="text-xs px-1.5 py-0.5 rounded-full font-medium"
                    style="background: rgb(var(--kitsuden-green) / 0.15); color: rgb(var(--kitsuden-green));"
                  >
                    {tr("themesView.live")}
                  </span>
                </div>
                <div class="space-y-1.5">
                  <div
                    class="h-2 rounded-sm w-full"
                    style="background: rgb(var(--kitsuden-border));"
                  ></div>
                  <div
                    class="h-2 rounded-sm w-3/4"
                    style="background: rgb(var(--kitsuden-border));"
                  ></div>
                  <div
                    class="h-2 rounded-sm w-1/2"
                    style="background: rgb(var(--kitsuden-border));"
                  ></div>
                </div>
                <div class="flex items-center gap-2 pt-1">
                  <!-- Drawings of buttons inside the mock-up, not controls. -->
                  <span
                    class="text-xs px-3 py-1.5 rounded-md font-medium"
                    style="background: rgb(var(--kitsuden-primary)); color: rgb(var(--kitsuden-bg));"
                  >
                    {tr("themesView.primary")}
                  </span>
                  <span
                    class="text-xs px-3 py-1.5 rounded-md font-medium"
                    style="background: rgb(var(--kitsuden-danger) / 0.15); color: rgb(var(--kitsuden-danger));"
                  >
                    {tr("themesView.danger")}
                  </span>
                </div>
              </div>

              <div class="flex gap-2">
                <span
                  class="text-xs px-2 py-1 rounded-full font-medium"
                  style="background: rgb(var(--kitsuden-green) / 0.15); color: rgb(var(--kitsuden-green));"
                >
                  {tr("themesView.success")}
                </span>
                <span
                  class="text-xs px-2 py-1 rounded-full font-medium"
                  style="background: rgb(var(--kitsuden-amber) / 0.15); color: rgb(var(--kitsuden-amber));"
                >
                  {tr("themesView.warning")}
                </span>
              </div>
            </div>
          </div>

          <!-- CSS Variables Inspector -->
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle mb-3">
              {tr("themesView.cssVariables")}
            </h3>
            <div class="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
              {#each cssVarEntries as entry (entry.key)}
                <div class="flex items-center gap-2.5 text-sm py-1">
                  <div
                    class="w-5 h-5 rounded-sm border shrink-0"
                    style="background: rgb({entry.value}); border-color: rgb(var(--kitsuden-border));"
                    title={entry.value}
                  ></div>
                  <code class="text-xs text-kitsuden-text-dim font-mono truncate">{entry.key}</code>
                  <span class="text-xs text-kitsuden-subtle ml-auto font-mono shrink-0"
                    >{entry.value}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        </Card>
      </div>
    </div>
  </div>

  <!-- Import Modal -->
  <Dialog
    bind:open={showImportModal}
    title={tr("themesView.installNewTheme")}
    description={tr("themesView.pasteAThemeconfigJsonObject")}
    size="lg"
  >
    {#snippet children()}
      <div class="space-y-3">
        <Textarea
          bind:value={jsonInput}
          rows={10}
          mono
          aria-label={tr("themesView.pasteAThemeconfigJsonObject")}
          placeholder={'{ "id": "custom", "name": "My Theme", "description": "A custom theme", "preview": "linear-gradient(135deg, #000, #fff)", "cssVars": { "--kitsuden-primary": "137 180 250" } }'}
        />

        {#if jsonError}
          <Alert variant="error">{jsonError}</Alert>
        {/if}
      </div>
    {/snippet}

    {#snippet footer()}
      <Button
        variant="secondary"
        onclick={() => {
          showImportModal = false;
          jsonError = "";
        }}
      >
        {tr("common.cancel")}
      </Button>
      <Button variant="secondary" onclick={validateJson}>
        <AlertCircle class="w-4 h-4" aria-hidden="true" />
        {tr("themesView.validate")}
      </Button>
      <Button onclick={importTheme}>
        <Upload class="w-4 h-4" />
        {tr("themesView.import")}
      </Button>
    {/snippet}
  </Dialog>
</ViewPage>
