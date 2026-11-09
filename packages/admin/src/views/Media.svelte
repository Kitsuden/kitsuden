<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  /**
   * Media.svelte
   *
   * Media Library management view with tabs:
   * - Library: Browse and manage files
   * - Folders: Folder management
   * - Upload: File upload
   * - Settings: Storage configuration
   */
  import {
    Image,
    Plus,
    X,
    Loader2,
    Trash2,
    Search,
    Grid3X3,
    List,
    Folder,
    Upload,
    Settings,
    Check,
    AlertCircle,
    Save,
    Server,
    HardDrive,
    Cloud,
    RefreshCw,
  } from "lucide-svelte";
  import { onMount } from "svelte";
  import { slide, fade } from "svelte/transition";

  import { isAdmin } from "$lib/auth.svelte";
  import { grimoireConfigStore } from "$lib/states/grimoire-config.svelte";
  import { mediaStore } from "$lib/states/media.svelte";
  // Inline storage providers config (avoiding import from unbuilt package)
  const storageProviders = [
    {
      id: "minio",
      label: t("media.minioSelfHostedS3"),
      description: t("media.selfHostedS3CompatibleStorage"),
      icon: "Server",
      fields: [
        {
          key: "endpoint",
          label: t("media.endpointUrl"),
          type: "url",
          placeholder: "http://localhost:9000",
        },
        {
          key: "bucket",
          label: t("media.bucketName"),
          type: "text",
          placeholder: "kitsuden-media",
        },
        { key: "accessKey", label: t("media.accessKey"), type: "text", placeholder: "minioadmin" },
        {
          key: "secretKey",
          label: t("media.secretKey"),
          type: "password",
          placeholder: "••••••••",
        },
        {
          key: "publicUrl",
          label: t("media.publicUrlOptional"),
          type: "url",
          placeholder: "http://localhost:9000/kitsuden-media",
        },
        { key: "useSSL", label: t("media.useSsl"), type: "checkbox" },
      ],
    },
    {
      id: "s3",
      label: t("media.awsS3"),
      description: t("media.amazonWebServicesS3Enterprise"),
      icon: "Cloud",
      fields: [
        { key: "region", label: t("media.region"), type: "text", placeholder: "us-east-1" },
        { key: "bucket", label: t("media.bucketName"), type: "text", placeholder: "my-bucket" },
        {
          key: "accessKeyId",
          label: t("media.accessKeyId"),
          type: "text",
          placeholder: t("media.akia"),
        },
        {
          key: "secretAccessKey",
          label: t("media.secretAccessKey"),
          type: "password",
          placeholder: "••••••••",
        },
      ],
    },
    {
      id: "local",
      label: t("media.localStorage"),
      description: t("media.storeFilesLocallyOnThe"),
      icon: "HardDrive",
      fields: [
        { key: "basePath", label: t("media.basePath"), type: "text", placeholder: "/data/media" },
        {
          key: "publicUrl",
          label: t("media.publicUrl"),
          type: "url",
          placeholder: "http://localhost:3001/media",
        },
      ],
    },
  ];

  // ─── Local State ───
  let activeTab = $state<"library" | "folders" | "upload" | "settings">("library");
  let showNewFolderDialog = $state(false);
  let newFolderName = $state("");
  let fileInput: HTMLInputElement | null = $state(null);
  let copiedId = $state<string | null>(null);

  // Config state
  let config: any = $state(grimoireConfigStore.getDefaultMediaConfig());
  let testResult = $state<{ success: boolean; message: string } | null>(null);
  let isTesting = $state(false);

  const GRIMOIRE_ID = "grimoire-media";
  const canConfigure = isAdmin();

  // ─── Load on mount ───
  onMount(() => {
    mediaStore.fetchFiles();
    mediaStore.fetchFolders();
    // Storage configuration is admin-only (GET /api/media/config gives a
    // 403 to the editor); the editor uploads and manages files, not the provider.
    if (canConfigure) loadConfig();
  });

  async function loadConfig() {
    const loaded = await grimoireConfigStore.loadConfig(GRIMOIRE_ID);
    if (loaded) {
      config = loaded as typeof config;
    }
  }

  // ─── Handlers de Library ───
  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      mediaStore.uploadFiles(input.files, mediaStore.selectedFolder?.id);
      activeTab = "library";
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      mediaStore.uploadFiles(files, mediaStore.selectedFolder?.id);
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    const folder = await mediaStore.createFolder(newFolderName, mediaStore.selectedFolder?.id);
    if (folder) {
      newFolderName = "";
      showNewFolderDialog = false;
    }
  }

  async function handleDeleteFile(id: string) {
    await mediaStore.deleteFile(id);
  }

  async function handleCopyUrl(url: string, id: string) {
    await navigator.clipboard.writeText(url);
    copiedId = id;
    setTimeout(() => (copiedId = null), 2000);
  }

  // ─── Handlers de Settings ───
  async function handleSaveConfig() {
    await grimoireConfigStore.saveConfig(GRIMOIRE_ID, config);
  }

  async function handleTestConnection() {
    isTesting = true;
    testResult = null;
    testResult = await grimoireConfigStore.testStorageConnection(GRIMOIRE_ID, config.storage);
    isTesting = false;
  }

  function setProvider(providerId: string) {
    const defaultConfigs: Record<string, any> = {
      minio: {
        provider: "minio",
        endpoint: "http://localhost:9000",
        bucket: "kitsuden-media",
        useSSL: false,
      },
      s3: { provider: "s3", region: "us-east-1", bucket: "" },
      local: { provider: "local", path: "./uploads", publicUrl: "http://localhost:3001/uploads" },
      r2: { provider: "r2", accountId: "", bucket: "" },
    };
    config.storage = defaultConfigs[providerId];
    testResult = null;
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(localeFormat());
  }

  // Get current provider fields
  const currentProvider = $derived(storageProviders.find((p) => p.id === config.storage.provider));
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-accent/20 to-kitsuden-purple/20 border border-kitsuden-accent/20 flex items-center justify-center"
        >
          <Image class="w-5 h-5 text-kitsuden-accent" />
        </div>
        {t("media.mediaLibrary")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">{t("media.manageYourImagesVideosAnd")}</p>
    </div>
  </div>

  <!-- Tabs -->
  <div class="border-b border-kitsuden-border">
    <div class="flex gap-1">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2"
        class:border-kitsuden-accent={activeTab === "library"}
        class:text-kitsuden-accent={activeTab === "library"}
        class:border-transparent={activeTab !== "library"}
        class:text-kitsuden-subtle={activeTab !== "library"}
        class:hover:text-kitsuden-text={activeTab !== "library"}
        onclick={() => (activeTab = "library")}
      >
        <Image class="w-4 h-4" />
        {t("media.library")}
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2"
        class:border-kitsuden-accent={activeTab === "folders"}
        class:text-kitsuden-accent={activeTab === "folders"}
        class:border-transparent={activeTab !== "folders"}
        class:text-kitsuden-subtle={activeTab !== "folders"}
        class:hover:text-kitsuden-text={activeTab !== "folders"}
        onclick={() => (activeTab = "folders")}
      >
        <Folder class="w-4 h-4" />
        {t("media.folders")}
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2"
        class:border-kitsuden-accent={activeTab === "upload"}
        class:text-kitsuden-accent={activeTab === "upload"}
        class:border-transparent={activeTab !== "upload"}
        class:text-kitsuden-subtle={activeTab !== "upload"}
        class:hover:text-kitsuden-text={activeTab !== "upload"}
        onclick={() => (activeTab = "upload")}
      >
        <Upload class="w-4 h-4" />
        {t("media.upload")}
      </button>
      {#if canConfigure}
        <button
          class="px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2"
          class:border-kitsuden-accent={activeTab === "settings"}
          class:text-kitsuden-accent={activeTab === "settings"}
          class:border-transparent={activeTab !== "settings"}
          class:text-kitsuden-subtle={activeTab !== "settings"}
          class:hover:text-kitsuden-text={activeTab !== "settings"}
          onclick={() => (activeTab = "settings")}
        >
          <Settings class="w-4 h-4" />
          {t("common.settings")}
        </button>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  <!-- TAB: LIBRARY -->
  <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  {#if activeTab === "library"}
    <div class="space-y-4" in:fade>
      <!-- Toolbar -->
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2 flex-1">
          <div class="relative flex-1 max-w-md">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle" />
            <input
              type="text"
              placeholder={t("media.searchFiles")}
              class="input pl-10 w-full"
              bind:value={mediaStore.searchQuery}
            />
          </div>
          <select class="input w-32" bind:value={mediaStore.filterType}>
            <option value="">{t("media.allTypes")}</option>
            <option value="image">{t("media.images")}</option>
            <option value="video">{t("media.videos")}</option>
            <option value="application">{t("media.documents")}</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex items-center bg-kitsuden-surface rounded-lg p-1">
            <button
              class="p-1.5 rounded transition-colors {mediaStore.viewMode === 'grid'
                ? 'bg-kitsuden-card text-kitsuden-text'
                : 'text-kitsuden-subtle hover:text-kitsuden-text'}"
              onclick={() => mediaStore.setViewMode("grid")}
            >
              <Grid3X3 class="w-4 h-4" />
            </button>
            <button
              class="p-1.5 rounded transition-colors {mediaStore.viewMode === 'list'
                ? 'bg-kitsuden-card text-kitsuden-text'
                : 'text-kitsuden-subtle hover:text-kitsuden-text'}"
              onclick={() => mediaStore.setViewMode("list")}
            >
              <List class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <!-- Breadcrumb -->
      <div class="flex items-center gap-2 text-sm">
        <button
          class="text-kitsuden-accent hover:underline"
          onclick={() => mediaStore.selectFolder(null)}
        >
          {t("media.root")}
        </button>
        {#if mediaStore.selectedFolder}
          <span class="text-kitsuden-subtle">/</span>
          <span class="text-kitsuden-text">{mediaStore.selectedFolder.name}</span>
        {/if}
        <span class="text-kitsuden-subtle ml-auto"
          >{mediaStore.filteredFiles.length} {t("media.files")}</span
        >
      </div>

      <!-- Loading / Empty / Grid / List -->
      {#if mediaStore.isLoading && mediaStore.files.length === 0}
        <div class="card p-12 text-center">
          <Loader2 class="w-8 h-8 text-kitsuden-accent animate-spin mx-auto mb-4" />
          <p class="text-kitsuden-subtle">{t("media.loadingFiles")}</p>
        </div>
      {:else if mediaStore.filteredFiles.length === 0}
        <div
          class="card p-12 text-center border-2 border-dashed border-kitsuden-border/50 hover:border-kitsuden-accent/30 transition-colors"
          ondrop={handleDrop}
          ondragover={handleDragOver}
          role="region"
          aria-label={t("media.dropFilesHere")}
        >
          <div
            class="w-16 h-16 mx-auto mb-4 rounded-full bg-kitsuden-accent/10 flex items-center justify-center"
          >
            <Image class="w-8 h-8 text-kitsuden-accent/50" />
          </div>
          <h3 class="text-lg font-medium text-kitsuden-text mb-2">{t("media.noFilesYet")}</h3>
          <p class="text-sm text-kitsuden-subtle max-w-md mx-auto mb-6">
            {t("media.uploadYourFirstFileOr")}
          </p>
          <button
            class="btn-primary inline-flex items-center gap-2"
            onclick={() => (activeTab = "upload")}
          >
            <Upload class="w-4 h-4" />
            {t("media.uploadFiles")}
          </button>
        </div>
      {:else if mediaStore.viewMode === "grid"}
        <div
          class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
        >
          {#each mediaStore.filteredFiles as file}
            <div
              class="group relative card overflow-hidden hover:ring-2 hover:ring-kitsuden-accent/30 transition-all"
            >
              <div
                class="aspect-square bg-kitsuden-surface flex items-center justify-center overflow-hidden"
              >
                {#if file.mimeType.startsWith("image/")}
                  <img
                    src={mediaStore.getFileUrl(file, "small")}
                    alt={file.altText || file.filename}
                    class="w-full h-full object-cover"
                    loading="lazy"
                  />
                {:else}
                  <span class="text-4xl">{mediaStore.getFileIcon(file.mimeType)}</span>
                {/if}
              </div>
              <div class="p-3">
                <p class="text-sm font-medium text-kitsuden-text truncate">{file.filename}</p>
                <p class="text-xs text-kitsuden-subtle">{mediaStore.formatFileSize(file.size)}</p>
              </div>
              <div
                class="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <button
                  class="p-1.5 rounded-lg bg-kitsuden-card/90 hover:bg-kitsuden-card text-kitsuden-text-dim hover:text-kitsuden-accent transition-colors"
                  title={t("media.copyUrl")}
                  onclick={() => handleCopyUrl(file.url || file.publicUrl || "", file.id)}
                >
                  {#if copiedId === file.id}
                    <Check class="w-3.5 h-3.5 text-green-500" />
                  {:else}
                    <span class="text-xs">{t("media.copy")}</span>
                  {/if}
                </button>
                <button
                  class="p-1.5 rounded-lg bg-kitsuden-card/90 hover:bg-kitsuden-card text-kitsuden-text-dim hover:text-kitsuden-accent-2 transition-colors"
                  title={t("common.delete")}
                  onclick={() => handleDeleteFile(file.id)}
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="card overflow-hidden">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-kitsuden-border bg-kitsuden-surface/50">
                <th
                  class="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle"
                  >{t("media.file")}</th
                >
                <th
                  class="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle"
                  >{t("common.type")}</th
                >
                <th
                  class="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle"
                  >{t("media.size")}</th
                >
                <th
                  class="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle text-right"
                  >{t("common.actions")}</th
                >
              </tr>
            </thead>
            <tbody>
              {#each mediaStore.filteredFiles as file}
                <tr
                  class="border-b border-kitsuden-border/50 hover:bg-kitsuden-surface/30 transition-colors group"
                >
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-3">
                      <div
                        class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center overflow-hidden shrink-0"
                      >
                        {#if file.mimeType.startsWith("image/")}
                          <img
                            src={mediaStore.getFileUrl(file, "small")}
                            alt=""
                            class="w-full h-full object-cover"
                            loading="lazy"
                          />
                        {:else}
                          <span class="text-lg">{mediaStore.getFileIcon(file.mimeType)}</span>
                        {/if}
                      </div>
                      <span class="font-medium text-kitsuden-text">{file.filename}</span>
                    </div>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="text-xs text-kitsuden-subtle bg-kitsuden-surface px-2 py-0.5 rounded-sm"
                      >{file.mimeType.split("/")[1]}</span
                    >
                  </td>
                  <td class="px-4 py-3 text-sm text-kitsuden-text-dim"
                    >{mediaStore.formatFileSize(file.size)}</td
                  >
                  <td class="px-4 py-3 text-right">
                    <div
                      class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <button
                        class="p-1.5 rounded-lg hover:bg-kitsuden-accent/10 text-kitsuden-text-dim hover:text-kitsuden-accent"
                        onclick={() => handleCopyUrl(file.url || file.publicUrl || "", file.id)}
                      >
                        {#if copiedId === file.id}<Check
                            class="w-4 h-4 text-green-500"
                          />{:else}<span class="text-xs">{t("media.copy")}</span>{/if}
                      </button>
                      <button
                        class="p-1.5 rounded-lg hover:bg-kitsuden-accent-2/10 text-kitsuden-text-dim hover:text-kitsuden-accent-2"
                        onclick={() => handleDeleteFile(file.id)}
                      >
                        <Trash2 class="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <!-- TAB: FOLDERS -->
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  {:else if activeTab === "folders"}
    <div class="space-y-4" in:fade>
      <div class="flex justify-end">
        <button
          class="btn-primary inline-flex items-center gap-2"
          onclick={() => (showNewFolderDialog = true)}
        >
          <Plus class="w-4 h-4" />
          {t("media.newFolder")}
        </button>
      </div>

      {#if mediaStore.folders.length === 0}
        <div class="card p-12 text-center">
          <Folder class="w-12 h-12 text-kitsuden-subtle mx-auto mb-4" />
          <h3 class="text-lg font-medium text-kitsuden-text mb-2">{t("media.noFolders")}</h3>
          <p class="text-sm text-kitsuden-subtle">{t("media.createFoldersToOrganizeYour")}</p>
        </div>
      {:else}
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {#each mediaStore.folders as folder}
            <div
              class="card p-4 flex items-center gap-3 hover:ring-2 hover:ring-kitsuden-accent/30 transition-all cursor-pointer"
              onclick={() => {
                mediaStore.selectFolder(folder);
                activeTab = "library";
              }}
            >
              <Folder class="w-8 h-8 text-kitsuden-accent" />
              <div>
                <p class="font-medium text-kitsuden-text">{folder.name}</p>
                <p class="text-xs text-kitsuden-subtle">{folder.path}</p>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <!-- TAB: UPLOAD -->
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  {:else if activeTab === "upload"}
    <div class="max-w-2xl mx-auto" in:fade>
      <div
        class="card p-12 text-center border-2 border-dashed border-kitsuden-border/50 hover:border-kitsuden-accent/30 transition-colors"
        ondrop={handleDrop}
        ondragover={handleDragOver}
        role="region"
        aria-label={t("media.dropFilesHere")}
      >
        <Upload class="w-16 h-16 text-kitsuden-accent mx-auto mb-6" />
        <h3 class="text-xl font-semibold text-kitsuden-text mb-2">{t("media.uploadFiles")}</h3>
        <p class="text-kitsuden-subtle mb-2">{t("media.dragAndDropFilesHere")}</p>
        <p class="text-xs text-kitsuden-text-dim mb-6">
          {t("media.supportsImagesVideosPdfsMax", { maxFileSize: config.features.maxFileSize })}
        </p>
        <input
          bind:this={fileInput}
          type="file"
          multiple
          class="hidden"
          onchange={handleFileSelect}
          accept={config.features.allowedTypes.join(",")}
        />
        <button
          class="btn-primary inline-flex items-center gap-2"
          onclick={() => fileInput?.click()}
        >
          <Plus class="w-4 h-4" />
          {t("media.selectFiles")}
        </button>
      </div>

      <!-- Upload Progress -->
      {#if mediaStore.uploadProgress.length > 0}
        <div class="card p-4 mt-4 space-y-3">
          <h4 class="text-sm font-medium text-kitsuden-text">{t("media.uploading")}</h4>
          {#each mediaStore.uploadProgress as progress}
            <div class="flex items-center gap-3">
              <span class="text-sm text-kitsuden-subtle truncate flex-1">{progress.filename}</span>
              <div class="w-24 h-2 bg-kitsuden-surface rounded-full overflow-hidden">
                <div
                  class="h-full bg-kitsuden-accent transition-all duration-300"
                  style="width: {progress.progress}%"
                ></div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <!-- TAB: SETTINGS -->
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
  {:else if activeTab === "settings"}
    <div class="max-w-3xl mx-auto space-y-6" in:fade>
      <!-- Storage Provider -->
      <div class="card p-6">
        <h3 class="text-lg font-semibold text-kitsuden-text mb-4 flex items-center gap-2">
          <Server class="w-5 h-5 text-kitsuden-accent" />
          {t("media.storageProvider")}
        </h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {#each storageProviders as provider}
            <button
              class="p-4 rounded-xl border-2 text-left transition-all flex items-start gap-3 {config
                .storage.provider === provider.id
                ? 'border-kitsuden-accent bg-kitsuden-accent/5'
                : 'border-kitsuden-border hover:border-kitsuden-accent/50'}"
              onclick={() => setProvider(provider.id)}
            >
              <div
                class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center shrink-0"
              >
                {#if provider.id === "minio"}
                  <Server class="w-5 h-5 text-kitsuden-accent" />
                {:else if provider.id === "local"}
                  <HardDrive class="w-5 h-5 text-kitsuden-accent" />
                {:else}
                  <Cloud class="w-5 h-5 text-kitsuden-accent" />
                {/if}
              </div>
              <div>
                <p class="font-medium text-kitsuden-text">{provider.label}</p>
                <p class="text-xs text-kitsuden-subtle mt-1">{provider.description}</p>
              </div>
            </button>
          {/each}
        </div>

        <!-- Provider-specific fields -->
        {#if currentProvider}
          <div class="space-y-4 border-t border-kitsuden-border pt-6">
            <h4 class="text-sm font-medium text-kitsuden-text">
              {t("media.configuration", { label: currentProvider.label })}
            </h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              {#each currentProvider.fields as field}
                <div class={field.type === "checkbox" ? "flex items-center gap-2" : ""}>
                  {#if field.type !== "checkbox"}
                    <label class="block text-sm text-kitsuden-subtle mb-1">{field.label}</label>
                  {/if}

                  {#if field.type === "checkbox"}
                    <input
                      type="checkbox"
                      class="w-4 h-4 rounded-sm border-kitsuden-border bg-kitsuden-surface text-kitsuden-accent focus:ring-kitsuden-accent"
                      bind:checked={config.storage[field.key]}
                    />
                    <label class="text-sm text-kitsuden-text">{field.label}</label>
                  {:else if field.type === "password"}
                    <input
                      type="password"
                      class="input w-full"
                      placeholder={field.placeholder}
                      bind:value={config.storage[field.key]}
                    />
                  {:else}
                    <input
                      type={field.type}
                      class="input w-full"
                      placeholder={field.placeholder}
                      bind:value={config.storage[field.key]}
                    />
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Test Connection -->
        <div class="flex items-center gap-3 mt-6 pt-6 border-t border-kitsuden-border">
          <button
            class="btn-secondary inline-flex items-center gap-2"
            onclick={handleTestConnection}
            disabled={isTesting}
          >
            {#if isTesting}
              <RefreshCw class="w-4 h-4 animate-spin" />
              {t("media.testing")}
            {:else}
              <RefreshCw class="w-4 h-4" />
              {t("media.testConnection")}
            {/if}
          </button>

          {#if testResult}
            <div
              class="flex items-center gap-2 text-sm"
              class:text-green-500={testResult.success}
              class:text-kitsuden-accent-2={!testResult.success}
            >
              {#if testResult.success}
                <Check class="w-4 h-4" />
              {:else}
                <AlertCircle class="w-4 h-4" />
              {/if}
              {testResult.message}
            </div>
          {/if}
        </div>
      </div>

      <!-- Features -->
      <div class="card p-6">
        <h3 class="text-lg font-semibold text-kitsuden-text mb-4">{t("media.features")}</h3>
        <div class="space-y-4">
          <div class="flex items-center justify-between p-3 bg-kitsuden-surface/50 rounded-lg">
            <div>
              <p class="font-medium text-kitsuden-text">{t("media.thumbnails")}</p>
              <p class="text-xs text-kitsuden-subtle">
                {t("media.generateThumbnailsForUploadedImages")}
              </p>
            </div>
            <input
              type="checkbox"
              class="w-5 h-5 rounded-sm border-kitsuden-border bg-kitsuden-surface text-kitsuden-accent focus:ring-kitsuden-accent"
              bind:checked={config.features.thumbnails}
            />
          </div>

          <div class="flex items-center justify-between p-3 bg-kitsuden-surface/50 rounded-lg">
            <div>
              <p class="font-medium text-kitsuden-text">{t("media.imageOptimization")}</p>
              <p class="text-xs text-kitsuden-subtle">{t("media.autoConvertImagesToWebp")}</p>
            </div>
            <input
              type="checkbox"
              class="w-5 h-5 rounded-sm border-kitsuden-border bg-kitsuden-surface text-kitsuden-accent focus:ring-kitsuden-accent"
              bind:checked={config.features.imageOptimization}
            />
          </div>

          <div class="flex items-center justify-between p-3 bg-kitsuden-surface/50 rounded-lg">
            <div>
              <p class="font-medium text-kitsuden-text">{t("media.signedUrls")}</p>
              <p class="text-xs text-kitsuden-subtle">
                {t("media.useTemporarySignedUrlsFor")}
              </p>
            </div>
            <input
              type="checkbox"
              class="w-5 h-5 rounded-sm border-kitsuden-border bg-kitsuden-surface text-kitsuden-accent focus:ring-kitsuden-accent"
              bind:checked={config.features.signedUrls}
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label for="maxfilesize" class="block text-sm text-kitsuden-subtle mb-1"
                >{t("media.maxFileSizeMb")}</label
              >
              <input
                id="maxfilesize"
                type="number"
                min="1"
                max="100"
                class="input w-full"
                bind:value={config.features.maxFileSize}
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Save Button -->
      <div class="flex items-center justify-between">
        {#if grimoireConfigStore.getConfigError(GRIMOIRE_ID)}
          <div class="text-sm text-kitsuden-accent-2 flex items-center gap-2">
            <AlertCircle class="w-4 h-4" />
            {grimoireConfigStore.getConfigError(GRIMOIRE_ID)}
          </div>
        {:else if grimoireConfigStore.getConfigSaveSuccess(GRIMOIRE_ID)}
          <div class="text-sm text-green-500 flex items-center gap-2">
            <Check class="w-4 h-4" />
            {t("media.settingsSavedSuccessfully")}
          </div>
        {:else}
          <div></div>
        {/if}

        <button
          class="btn-primary inline-flex items-center gap-2"
          onclick={handleSaveConfig}
          disabled={grimoireConfigStore.isConfigSaving(GRIMOIRE_ID)}
        >
          {#if grimoireConfigStore.isConfigSaving(GRIMOIRE_ID)}
            <Loader2 class="w-4 h-4 animate-spin" />
            {t("common.saving")}
          {:else}
            <Save class="w-4 h-4" />
            {t("media.saveSettings")}
          {/if}
        </button>
      </div>
    </div>
  {/if}
</div>

<!-- New Folder Dialog -->
{#if showNewFolderDialog}
  <div
    class="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50"
    transition:fade
  >
    <div class="card p-6 w-full max-w-md mx-4" transition:slide>
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-kitsuden-text">{t("media.newFolder")}</h3>
        <button
          class="text-kitsuden-subtle hover:text-kitsuden-text"
          onclick={() => (showNewFolderDialog = false)}
        >
          <X class="w-5 h-5" />
        </button>
      </div>
      <input
        type="text"
        placeholder={t("media.folderName")}
        class="input w-full mb-4"
        bind:value={newFolderName}
        onkeydown={(e) => e.key === "Enter" && handleCreateFolder()}
      />
      <div class="flex justify-end gap-2">
        <button class="btn-secondary" onclick={() => (showNewFolderDialog = false)}
          >{t("common.cancel")}</button
        >
        <button class="btn-primary" onclick={handleCreateFolder} disabled={!newFolderName.trim()}>
          {t("common.create")}
        </button>
      </div>
    </div>
  </div>
{/if}
