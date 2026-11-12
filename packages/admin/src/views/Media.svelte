<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    EmptyState,
    Field,
    Input,
    Label,
    NumberInput,
    Progress,
    RadioGroup,
    SaveBar,
    SearchInput,
    Select,
    Spinner,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Tabs,
    ToggleGroup,
    type TabItem,
  } from "$lib/tallao";
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
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
  import { Plus, Trash2, Grid3X3, List, Folder, Upload, Check, RefreshCw } from "lucide-svelte";
  import { onMount } from "svelte";
  import { fade } from "$lib/tallao/motion";

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
  let activeTab = $state<string>("library");
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

  /** The configuration as last loaded or saved: what the SaveBar compares against. */
  let savedConfig = $state(JSON.stringify(grimoireConfigStore.getDefaultMediaConfig()));
  const configDirty = $derived(JSON.stringify(config) !== savedConfig);

  const tabItems = $derived<TabItem[]>([
    { id: "library", label: t("media.library") },
    { id: "folders", label: t("media.folders") },
    { id: "upload", label: t("media.upload") },
    ...(canConfigure ? [{ id: "settings", label: t("common.settings") }] : []),
  ]);

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
      savedConfig = JSON.stringify(config);
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
    const ok = await grimoireConfigStore.saveConfig(GRIMOIRE_ID, config);
    if (ok) savedConfig = JSON.stringify(config);
  }

  function discardConfig() {
    config = JSON.parse(savedConfig);
    testResult = null;
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

<ViewPage title={t("media.mediaLibrary")} description={t("media.manageYourImagesVideosAnd")}>
  {#snippet tabs()}
    <Tabs items={tabItems} bind:value={activeTab} panels={false} ariaLabel={t("media.sections")} />
  {/snippet}

  <div class="space-y-6 min-w-0">
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <!-- TAB: LIBRARY -->
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    {#if activeTab === "library"}
      <div class="space-y-4" in:fade>
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2 flex-1 min-w-0">
            <SearchInput
              class="flex-1 min-w-40 max-w-md"
              placeholder={t("media.searchFiles")}
              bind:value={mediaStore.searchQuery}
            />
            <Select
              width="auto"
              aria-label={t("media.typeFilter")}
              bind:value={mediaStore.filterType}
            >
              <option value="">{t("media.allTypes")}</option>
              <option value="image">{t("media.images")}</option>
              <option value="video">{t("media.videos")}</option>
              <option value="application">{t("media.documents")}</option>
            </Select>
          </div>
          <ToggleGroup
            ariaLabel={t("media.viewMode")}
            required
            size="sm"
            value={mediaStore.viewMode}
            onchange={(mode) => mediaStore.setViewMode(mode === "list" ? "list" : "grid")}
            options={[
              { value: "grid", label: t("media.viewGrid"), ariaLabel: t("media.viewGrid") },
              { value: "list", label: t("media.viewList"), ariaLabel: t("media.viewList") },
            ]}
          >
            {#snippet item(option)}
              {#if option.value === "grid"}
                <Grid3X3 class="w-4 h-4" aria-hidden="true" />
              {:else}
                <List class="w-4 h-4" aria-hidden="true" />
              {/if}
            {/snippet}
          </ToggleGroup>
        </div>

        <!-- Breadcrumb -->
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <Button variant="ghost" size="sm" onclick={() => mediaStore.selectFolder(null)}>
            {t("media.root")}
          </Button>
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
          <Card class="p-12 flex flex-col items-center gap-4 text-center">
            <Spinner size="lg" class="text-kitsuden-accent" label={t("media.loadingFiles")} />
            <p class="text-kitsuden-subtle" aria-hidden="true">{t("media.loadingFiles")}</p>
          </Card>
        {:else if mediaStore.loadError && mediaStore.files.length === 0}
          <!-- The error replaces the empty state: a failed load is not "no files yet". -->
          <EmptyState
            variant="error"
            level={2}
            title={t("media.loadFailed")}
            description={mediaStore.loadError}
            onRetry={() => void mediaStore.fetchFiles()}
            retrying={mediaStore.isLoading}
          />
        {:else if mediaStore.filteredFiles.length === 0}
          <div
            class="rounded-xl border-2 border-dashed border-kitsuden-border/50 hover:border-kitsuden-accent/30 transition-colors"
            ondrop={handleDrop}
            ondragover={handleDragOver}
            role="region"
            aria-label={t("media.dropFilesHere")}
          >
            <EmptyState
              title={t("media.noFilesYet")}
              description={t("media.uploadYourFirstFileOr")}
              actionLabel={t("media.uploadFiles")}
              onAction={() => (activeTab = "upload")}
            />
          </div>
        {:else if mediaStore.viewMode === "grid"}
          <div
            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
          >
            {#each mediaStore.filteredFiles as file}
              <Card
                class="group relative overflow-hidden hover:ring-2 hover:ring-kitsuden-accent/30 transition-all"
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
                <div class="p-3 min-w-0">
                  <p class="text-sm font-medium text-kitsuden-text truncate">{file.filename}</p>
                  <p class="text-xs text-kitsuden-subtle">{mediaStore.formatFileSize(file.size)}</p>
                </div>
                <div
                  class="absolute top-2 right-2 flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity"
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    title={t("media.copyUrl")}
                    ariaLabel={t("media.copyUrl")}
                    onclick={() => handleCopyUrl(file.url || file.publicUrl || "", file.id)}
                  >
                    {#if copiedId === file.id}
                      <Check class="w-3.5 h-3.5 text-kitsuden-green" aria-hidden="true" />
                    {:else}
                      {t("media.copy")}
                    {/if}
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    class="text-kitsuden-danger"
                    title={t("common.delete")}
                    ariaLabel={t("media.deleteFile", { name: file.filename })}
                    onclick={() => handleDeleteFile(file.id)}
                  >
                    <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </Card>
            {/each}
          </div>
        {:else}
          <Table aria-label={t("media.files")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("media.file")}</TableHead>
                <TableHead>{t("common.type")}</TableHead>
                <TableHead>{t("media.size")}</TableHead>
                <TableHead class="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each mediaStore.filteredFiles as file}
                <TableRow>
                  <TableCell>
                    <div class="flex items-center gap-3 min-w-0">
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
                      <span class="font-medium text-kitsuden-text break-all">{file.filename}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{file.mimeType.split("/")[1]}</Badge>
                  </TableCell>
                  <TableCell class="text-kitsuden-text-dim"
                    >{mediaStore.formatFileSize(file.size)}</TableCell
                  >
                  <TableCell class="text-right">
                    <div class="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t("media.copyUrl")}
                        ariaLabel={t("media.copyUrl")}
                        onclick={() => handleCopyUrl(file.url || file.publicUrl || "", file.id)}
                      >
                        {#if copiedId === file.id}
                          <Check class="w-4 h-4 text-kitsuden-green" aria-hidden="true" />
                        {:else}
                          {t("media.copy")}
                        {/if}
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="icon"
                        title={t("common.delete")}
                        ariaLabel={t("media.deleteFile", { name: file.filename })}
                        onclick={() => handleDeleteFile(file.id)}
                      >
                        <Trash2 class="w-4 h-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        {/if}
      </div>

      <!-- ═══════════════════════════════════════════════════════════════════════════ -->
      <!-- TAB: FOLDERS -->
      <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    {:else if activeTab === "folders"}
      <div class="space-y-4" in:fade>
        <div class="flex justify-end">
          <Button onclick={() => (showNewFolderDialog = true)}>
            <Plus class="w-4 h-4" />
            {t("media.newFolder")}
          </Button>
        </div>

        {#if mediaStore.folders.length === 0}
          <Card>
            <EmptyState
              title={t("media.noFolders")}
              description={t("media.createFoldersToOrganizeYour")}
              actionLabel={t("media.newFolder")}
              onAction={() => (showNewFolderDialog = true)}
            />
          </Card>
        {:else}
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {#each mediaStore.folders as folder}
              <!-- The whole card opens the folder: one large native button. -->
              <button
                type="button"
                class="p-4 flex items-center gap-3 min-w-0 text-left rounded-xl border border-kitsuden-border bg-kitsuden-surface/50 hover:ring-2 hover:ring-kitsuden-accent/30 transition-all cursor-pointer"
                onclick={() => {
                  mediaStore.selectFolder(folder);
                  activeTab = "library";
                }}
              >
                <Folder class="w-8 h-8 shrink-0 text-kitsuden-accent" aria-hidden="true" />
                <span class="min-w-0">
                  <span class="block font-medium text-kitsuden-text truncate">{folder.name}</span>
                  <span class="block text-xs text-kitsuden-subtle truncate">{folder.path}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- ═══════════════════════════════════════════════════════════════════════════ -->
      <!-- TAB: UPLOAD -->
      <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    {:else if activeTab === "upload"}
      <div class="max-w-2xl mx-auto w-full" in:fade>
        <div
          class="p-8 sm:p-12 text-center rounded-xl border-2 border-dashed border-kitsuden-border/50 hover:border-kitsuden-accent/30 transition-colors"
          ondrop={handleDrop}
          ondragover={handleDragOver}
          role="region"
          aria-label={t("media.dropFilesHere")}
        >
          <Upload class="w-16 h-16 text-kitsuden-accent mx-auto mb-6" aria-hidden="true" />
          <h3 class="text-xl font-semibold text-kitsuden-text mb-2">{t("media.uploadFiles")}</h3>
          <p class="text-kitsuden-subtle mb-2">{t("media.dragAndDropFilesHere")}</p>
          <p class="text-xs text-kitsuden-text-dim mb-6">
            {t("media.supportsImagesVideosPdfsMax", { maxFileSize: config.features.maxFileSize })}
          </p>
          <!-- The native file field: the kit's Button opens it. -->
          <input
            bind:this={fileInput}
            type="file"
            multiple
            class="hidden"
            tabindex="-1"
            aria-hidden="true"
            onchange={handleFileSelect}
            accept={config.features.allowedTypes.join(",")}
          />
          <Button onclick={() => fileInput?.click()}>
            <Plus class="w-4 h-4" />
            {t("media.selectFiles")}
          </Button>
        </div>

        <!-- Upload Progress -->
        {#if mediaStore.uploadProgress.length > 0}
          <Card class="mt-4">
            <CardHeader><CardTitle level={3}>{t("media.uploading")}</CardTitle></CardHeader>
            <CardContent class="space-y-3">
              {#each mediaStore.uploadProgress as progress}
                <Progress value={progress.progress} label={progress.filename} />
              {/each}
            </CardContent>
          </Card>
        {/if}
      </div>

      <!-- ═══════════════════════════════════════════════════════════════════════════ -->
      <!-- TAB: SETTINGS -->
      <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    {:else if activeTab === "settings"}
      <div class="max-w-3xl mx-auto w-full space-y-6" in:fade>
        <!-- Storage Provider -->
        <Card>
          <CardHeader><CardTitle level={2}>{t("media.storageProvider")}</CardTitle></CardHeader>
          <CardContent class="space-y-6">
            <RadioGroup
              legend={t("media.storageProvider")}
              hideLegend
              value={config.storage.provider}
              onchange={setProvider}
              options={storageProviders.map((provider) => ({
                value: provider.id,
                label: provider.label,
                description: provider.description,
              }))}
            />

            <!-- Provider-specific fields -->
            {#if currentProvider}
              <div class="space-y-4 border-t border-kitsuden-border pt-6">
                <h3 class="text-sm font-medium text-kitsuden-text">
                  {t("media.configuration", { label: currentProvider.label })}
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {#each currentProvider.fields as field}
                    {#if field.type === "checkbox"}
                      <Checkbox label={field.label} bind:checked={config.storage[field.key]} />
                    {:else}
                      <Field label={field.label}>
                        <Input
                          type={field.type}
                          placeholder={field.placeholder}
                          bind:value={config.storage[field.key]}
                        />
                      </Field>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Test Connection -->
            <div
              class="flex flex-wrap items-center gap-3 pt-6 border-t border-kitsuden-border min-w-0"
            >
              <Button variant="secondary" onclick={handleTestConnection} loading={isTesting}>
                {#if isTesting}
                  {t("media.testing")}
                {:else}
                  <RefreshCw class="w-4 h-4" aria-hidden="true" />
                  {t("media.testConnection")}
                {/if}
              </Button>

              {#if testResult}
                <Alert variant={testResult.success ? "success" : "error"} class="flex-1 min-w-48">
                  {testResult.message}
                </Alert>
              {/if}
            </div>
          </CardContent>
        </Card>

        <!-- Features -->
        <Card>
          <CardHeader><CardTitle level={2}>{t("media.features")}</CardTitle></CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="font-medium text-kitsuden-text">{t("media.thumbnails")}</p>
                <p class="text-xs text-kitsuden-subtle">
                  {t("media.generateThumbnailsForUploadedImages")}
                </p>
              </div>
              <Checkbox
                ariaLabel={t("media.thumbnails")}
                bind:checked={config.features.thumbnails}
              />
            </div>

            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="font-medium text-kitsuden-text">{t("media.imageOptimization")}</p>
                <p class="text-xs text-kitsuden-subtle">{t("media.autoConvertImagesToWebp")}</p>
              </div>
              <Checkbox
                ariaLabel={t("media.imageOptimization")}
                bind:checked={config.features.imageOptimization}
              />
            </div>

            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="font-medium text-kitsuden-text">{t("media.signedUrls")}</p>
                <p class="text-xs text-kitsuden-subtle">
                  {t("media.useTemporarySignedUrlsFor")}
                </p>
              </div>
              <Checkbox
                ariaLabel={t("media.signedUrls")}
                bind:checked={config.features.signedUrls}
              />
            </div>

            <div class="max-w-xs space-y-1.5">
              <Label for="maxfilesize">{t("media.maxFileSizeMb")}</Label>
              <NumberInput
                id="maxfilesize"
                min={1}
                max={100}
                clamp={false}
                bind:value={config.features.maxFileSize}
              />
            </div>
          </CardContent>
        </Card>

        <SaveBar
          dirty={configDirty}
          saving={grimoireConfigStore.isConfigSaving(GRIMOIRE_ID)}
          error={grimoireConfigStore.getConfigError(GRIMOIRE_ID) ?? undefined}
          savedText={grimoireConfigStore.getConfigSaveSuccess(GRIMOIRE_ID)
            ? t("media.settingsSavedSuccessfully")
            : ""}
          saveLabel={t("media.saveSettings")}
          onSave={handleSaveConfig}
          cancelLabel={t("record.discard")}
          onCancel={configDirty ? discardConfig : undefined}
        />
      </div>
    {/if}
  </div>

  <!-- New Folder Dialog -->
  <Dialog
    open={!!showNewFolderDialog}
    title={t("media.newFolder")}
    size="sm"
    onClose={() => (showNewFolderDialog = false)}
  >
    <Field label={t("media.folderName")}>
      <Input
        placeholder={t("media.folderName")}
        bind:value={newFolderName}
        onkeydown={(e: KeyboardEvent) => e.key === "Enter" && handleCreateFolder()}
      />
    </Field>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (showNewFolderDialog = false)}
        >{t("common.cancel")}</Button
      >
      <Button onclick={handleCreateFolder} disabled={!newFolderName.trim()}>
        {t("common.create")}
      </Button>
    {/snippet}
  </Dialog>
</ViewPage>
