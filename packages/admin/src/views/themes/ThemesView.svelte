<script lang="ts">
  import { t as tr } from "$lib/i18n";
  import { Palette, Check, Download, Trash2, Eye, Upload, AlertCircle } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  import Modal from "$lib/components/ui/Modal.svelte";
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

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-purple/20 to-kitsuden-accent/20 border border-kitsuden-purple/20 flex items-center justify-center"
        >
          <Palette class="w-5 h-5 text-kitsuden-purple" />
        </div>
        {tr("themesView.themes")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {tr("themesView.customizeAppearancePreviewChanges")}
      </p>
    </div>
  </div>

  <!-- Main Layout -->
  <div class="flex flex-col lg:flex-row gap-6">
    <!-- Left: Theme Cards -->
    <div class="lg:w-[60%] space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {#each allThemes as theme (theme.id)}
          <div
            class="card p-4 relative group transition-all"
            class:border-kitsuden-accent={currentTheme() === theme.id}
            class:border-2={currentTheme() === theme.id}
            class:border-kitsuden-border={currentTheme() !== theme.id}
          >
            {#if currentTheme() === theme.id}
              <div class="absolute top-2 right-2">
                <span
                  class="px-2 py-1 text-xs font-medium bg-kitsuden-accent/10 text-kitsuden-accent rounded-full"
                >
                  {tr("common.active")}
                </span>
              </div>
            {/if}

            <div class="flex items-center gap-3 mb-3">
              <div
                class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style="background: {theme.preview}"
              >
                <Palette class="w-5 h-5 text-kitsuden-text" />
              </div>
              <div class="min-w-0">
                <h3 class="font-semibold text-kitsuden-text truncate">{theme.name}</h3>
                <p class="text-xs text-kitsuden-subtle">{theme.description}</p>
              </div>
            </div>

            <div class="flex items-center gap-2 mt-4">
              {#if currentTheme() === theme.id}
                <button class="btn-secondary flex-1" disabled>
                  <Check class="w-4 h-4" />
                  {tr("common.active")}
                </button>
              {:else}
                <button class="btn-primary flex-1" onclick={() => handleActivate(theme.id)}>
                  {tr("common.activate")}
                </button>
              {/if}

              {#if !builtinThemes.some((t) => t.id === theme.id)}
                <button
                  class="p-2 rounded-lg text-kitsuden-text-dim hover:bg-kitsuden-accent-2/10 hover:text-kitsuden-accent-2 transition-colors"
                  onclick={() => handleDelete(theme)}
                  title={tr("themesView.deleteTheme")}
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              {/if}
            </div>
          </div>
        {/each}

        <!-- Install New Theme Card -->
        <button
          class="card p-4 border-dashed border-2 border-kitsuden-border hover:border-kitsuden-accent/50 transition-colors flex flex-col items-center justify-center min-h-[160px] gap-3"
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
            <p class="text-xs text-kitsuden-subtle mt-0.5">{tr("themesView.pasteJsonToImport")}</p>
          </div>
        </button>
      </div>
    </div>

    <!-- Right: Live Preview Panel -->
    <div class="lg:w-[40%] space-y-4">
      <div class="card p-5 border border-kitsuden-border sticky top-4">
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
                <button
                  class="text-xs px-3 py-1.5 rounded-md font-medium"
                  style="background: rgb(var(--kitsuden-primary)); color: rgb(var(--kitsuden-bg));"
                >
                  {tr("themesView.primary")}
                </button>
                <button
                  class="text-xs px-3 py-1.5 rounded-md font-medium"
                  style="background: rgb(var(--kitsuden-danger) / 0.15); color: rgb(var(--kitsuden-danger));"
                >
                  {tr("themesView.danger")}
                </button>
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
      </div>
    </div>
  </div>
</div>

<!-- Import Modal -->
<Modal
  bind:open={showImportModal}
  title={tr("themesView.installNewTheme")}
  description={tr("themesView.pasteAThemeconfigJsonObject")}
  size="lg"
>
  {#snippet children()}
    <div class="space-y-3">
      <textarea
        bind:value={jsonInput}
        rows="10"
        placeholder={'{ "id": "custom", "name": "My Theme", "description": "A custom theme", "preview": "linear-gradient(135deg, #000, #fff)", "cssVars": { "--kitsuden-primary": "137 180 250" } }'}
        class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-input rounded-lg px-3 py-2 text-xs font-mono placeholder:text-kitsuden-subtle focus:outline-hidden focus:border-kitsuden-accent resize-y"
      ></textarea>

      {#if jsonError}
        <div class="flex items-center gap-2 text-xs text-kitsuden-accent-2">
          <AlertCircle class="w-4 h-4 shrink-0" />
          {jsonError}
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <button
      class="btn-secondary"
      onclick={() => {
        showImportModal = false;
        jsonError = "";
      }}
    >
      {tr("common.cancel")}
    </button>
    <button class="btn-secondary" onclick={validateJson}>
      <AlertCircle class="w-4 h-4" />
      {tr("themesView.validate")}
    </button>
    <button class="btn-primary" onclick={importTheme}>
      <Upload class="w-4 h-4" />
      {tr("themesView.import")}
    </button>
  {/snippet}
</Modal>
