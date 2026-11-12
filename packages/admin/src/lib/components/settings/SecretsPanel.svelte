<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    EmptyState,
    Input,
    Label,
    Select,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  /**
   * KITSUDEN Secrets Manager — Admin panel (KITSUDEN architecture §7)
   *
   * Prefect-style: encrypted secrets (AES-256-GCM) in PostgreSQL with
   * HOT injection into the API's process.env — without restarting Bun.
   * Consumes /api/admin/secrets (admin-only).
   */
  import {
    KeyRound,
    Plus,
    Trash2,
    Zap,
    RefreshCw,
    CheckCircle2,
    Eye,
    EyeOff,
    X,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  interface SecretMeta {
    id: string;
    key: string;
    description: string | null;
    category: string;
    autoInject: boolean;
    lastRotatedAt: string | null;
    lastInjectedAt: string | null;
    createdAt: string;
    updatedAt: string;
    hint: string;
  }

  let secrets = $state<SecretMeta[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let successMsg = $state<string | null>(null);

  // Create/rotate form
  let showForm = $state(false);
  let formKey = $state("");
  let formValue = $state("");
  let formDescription = $state("");
  let formCategory = $state("general");
  let formAutoInject = $state(true);
  let formShowValue = $state(false);
  let saving = $state(false);

  // Delete confirmation
  let deleteTarget = $state<string | null>(null);

  let busyKey = $state<string | null>(null);

  const KEY_RE = /^[A-Z][A-Z0-9_]{1,199}$/;
  const keyValid = $derived(formKey === "" || KEY_RE.test(formKey));

  const categories = ["general", "llm", "storage", "integrations", "database"];

  function flash(msg: string) {
    successMsg = msg;
    setTimeout(() => (successMsg = null), 3500);
  }

  async function fetchSecrets() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`${API_URL}/api/admin/secrets`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      secrets = data.secrets ?? [];
    } catch (e) {
      error = t("secretsPanel.couldNotLoadThe", { v: (e as Error).message });
    } finally {
      loading = false;
    }
  }

  async function saveSecret() {
    if (!KEY_RE.test(formKey) || !formValue) return;
    saving = true;
    error = null;
    try {
      const res = await fetch(`${API_URL}/api/admin/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          key: formKey,
          value: formValue,
          description: formDescription || undefined,
          category: formCategory,
          autoInject: formAutoInject,
          injectNow: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(`${formKey} saved and hot-injected ⚡`);
      showForm = false;
      formKey = "";
      formValue = "";
      formDescription = "";
      formCategory = "general";
      formAutoInject = true;
      await fetchSecrets();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function deleteSecret(key: string) {
    busyKey = key;
    try {
      const res = await fetch(`${API_URL}/api/admin/secrets/${encodeURIComponent(key)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(`${key} deleted from the DB and from process.env`);
      deleteTarget = null;
      await fetchSecrets();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busyKey = null;
    }
  }

  async function injectSecret(key: string) {
    busyKey = key;
    try {
      const res = await fetch(`${API_URL}/api/admin/secrets/${encodeURIComponent(key)}/inject`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(`${key} injected into process.env ⚡ (no restart)`);
      await fetchSecrets();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busyKey = null;
    }
  }

  async function reloadAll() {
    busyKey = "__all__";
    try {
      const res = await fetch(`${API_URL}/api/admin/secrets/reload`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(`${data.injected} secret(s) re-injected into process.env`);
      await fetchSecrets();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busyKey = null;
    }
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(localeFormat());
  }

  onMount(fetchSecrets);
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
        <KeyRound class="w-5 h-5 text-kitsuden-accent" aria-hidden="true" />
        {t("secretsPanel.secretsManager")}
      </h2>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("secretsPanel.encryptedWithAes256Gcm")}
        <code class="text-kitsuden-accent text-xs">process.env</code>
        {t("secretsPanel.withoutRestartingTheServer")}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onclick={reloadAll} loading={busyKey === "__all__"}>
        {#if busyKey !== "__all__"}<RefreshCw class="w-4 h-4" aria-hidden="true" />{/if}
        {t("secretsPanel.reinjectAll")}
      </Button>
      <Button onclick={() => (showForm = !showForm)} aria-expanded={showForm}>
        <Plus class="w-4 h-4" aria-hidden="true" />
        {t("secretsPanel.newSecret")}
      </Button>
    </div>
  </div>

  <!-- Messages -->
  {#if error}
    <Alert variant="error" onDismiss={() => (error = null)}>{error}</Alert>
  {/if}
  {#if successMsg}
    <Alert variant="success">{successMsg}</Alert>
  {/if}

  <!-- Create/rotate form -->
  {#if showForm}
    <Card class="p-4 space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="space-y-1.5">
          <Label for="secret-key">{t("secretsPanel.keyUpperSnakeCase")}</Label>
          <Input
            id="secret-key"
            class="font-mono!"
            placeholder={t("secretsPanel.openaiApiKey")}
            aria-invalid={!keyValid}
            aria-describedby={keyValid ? undefined : "secret-key-error"}
            bind:value={formKey}
          />
          {#if !keyValid}
            <p id="secret-key-error" class="text-xs text-kitsuden-danger">
              {t("secretsPanel.upperCaseUnderscoreFormat")}
            </p>
          {/if}
        </div>
        <div class="space-y-1.5">
          <Label for="secret-value">{t("secretsPanel.value")}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="secret-value"
              type={formShowValue ? "text" : "password"}
              class="font-mono! min-w-0 flex-1"
              placeholder="sk-..."
              autocomplete="off"
              bind:value={formValue}
            />
            <Button
              variant="ghost"
              size="icon"
              onclick={() => (formShowValue = !formShowValue)}
              ariaLabel={formShowValue ? t("secretsPanel.hideValue") : t("secretsPanel.showValue")}
              title={formShowValue ? t("secretsPanel.hideValue") : t("secretsPanel.showValue")}
            >
              {#if formShowValue}
                <EyeOff class="w-4 h-4" aria-hidden="true" />
              {:else}
                <Eye class="w-4 h-4" aria-hidden="true" />
              {/if}
            </Button>
          </div>
        </div>
        <div class="space-y-1.5">
          <Label for="secret-desc">{t("secretsPanel.optionalDescription")}</Label>
          <Input
            id="secret-desc"
            placeholder={t("secretsPanel.productionApiKeyOf")}
            bind:value={formDescription}
          />
        </div>
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex-1 min-w-40 space-y-1.5">
            <Label for="secret-cat">{t("secretsPanel.category")}</Label>
            <Select id="secret-cat" bind:value={formCategory}>
              {#each categories as cat (cat)}
                <option value={cat}>{cat}</option>
              {/each}
            </Select>
          </div>
          <Checkbox
            class="pb-2"
            bind:checked={formAutoInject}
            label={t("secretsPanel.autoInjectAtBoot")}
          />
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          onclick={saveSecret}
          loading={saving}
          disabled={!KEY_RE.test(formKey) || !formValue}
        >
          {saving ? t("secretsPanel.saving") : t("secretsPanel.saveAndInject")}
        </Button>
        <Button variant="ghost" onclick={() => (showForm = false)}>
          {t("common.cancel")}
        </Button>
        <p class="text-xs text-kitsuden-subtle sm:ml-auto">
          {t("secretsPanel.ifKeyAlreadyExists")}
        </p>
      </div>
    </Card>
  {/if}

  <!-- List -->
  {#if loading}
    <div class="flex items-center justify-center gap-2 py-12 text-kitsuden-subtle text-sm">
      <Spinner size="sm" label={t("secretsPanel.loadingSecrets")} />
      <span aria-hidden="true">{t("secretsPanel.loadingSecrets")}</span>
    </div>
  {:else if secrets.length === 0}
    <EmptyState title={t("secretsPanel.withoutSecretsYet")}>
      <p class="text-xs text-kitsuden-subtle max-w-sm">
        {t("secretsPanel.createsYourFirstSecretAnd")}
        <code>process.env</code>
        {t("secretsPanel.instantlyWithoutTouchingFiles")}
      </p>
    </EmptyState>
  {:else}
    <Table density="compact">
      <TableHeader>
        <TableRow>
          <TableHead class="text-left">{t("secretsPanel.key")}</TableHead>
          <TableHead class="text-left">{t("secretsPanel.value")}</TableHead>
          <TableHead class="text-left">{t("secretsPanel.category")}</TableHead>
          <TableHead class="text-left">{t("secretsPanel.auto")}</TableHead>
          <TableHead class="text-left">{t("secretsPanel.rotated")}</TableHead>
          <TableHead class="text-left">{t("secretsPanel.injected")}</TableHead>
          <TableHead class="text-right">{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each secrets as s (s.id)}
          <TableRow>
            <TableCell>
              <div class="font-mono text-kitsuden-text">{s.key}</div>
              {#if s.description}
                <div class="text-xs text-kitsuden-subtle mt-0.5">{s.description}</div>
              {/if}
            </TableCell>
            <TableCell class="font-mono">{s.hint}</TableCell>
            <TableCell>
              <Badge variant="purple">{s.category}</Badge>
            </TableCell>
            <TableCell>
              {#if s.autoInject}
                <CheckCircle2
                  class="w-4 h-4 text-kitsuden-green"
                  aria-label={t("secretsPanel.autoInjectAtBoot")}
                />
              {:else}
                <span class="text-kitsuden-subtle text-xs">{t("secretsPanel.manual")}</span>
              {/if}
            </TableCell>
            <TableCell>{fmtDate(s.lastRotatedAt)}</TableCell>
            <TableCell>{fmtDate(s.lastInjectedAt)}</TableCell>
            <TableCell>
              <div class="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("secretsPanel.injectIntoProcessEnvNow")}
                  ariaLabel={t("secretsPanel.injectIntoProcessEnvNow")}
                  onclick={() => injectSecret(s.key)}
                  disabled={busyKey === s.key}
                >
                  <Zap class="w-4 h-4" aria-hidden="true" />
                </Button>
                {#if deleteTarget === s.key}
                  <Button
                    variant="danger"
                    size="sm"
                    onclick={() => deleteSecret(s.key)}
                    disabled={busyKey === s.key}
                  >
                    {t("secretsPanel.confirm")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    ariaLabel={t("common.cancel")}
                    title={t("common.cancel")}
                    onclick={() => (deleteTarget = null)}
                  >
                    <X class="w-4 h-4" aria-hidden="true" />
                  </Button>
                {:else}
                  <Button
                    variant="danger-ghost"
                    size="icon"
                    title={t("secretsPanel.removeDbProcessEnv")}
                    ariaLabel={t("secretsPanel.removeDbProcessEnv")}
                    onclick={() => (deleteTarget = s.key)}
                  >
                    <Trash2 class="w-4 h-4" aria-hidden="true" />
                  </Button>
                {/if}
              </div>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
    <p class="text-xs text-kitsuden-subtle">
      {t("secretsPanel.valuesAreNeverShown")} <code>KITSUDEN_SECRETS_KEY</code>
      {t("secretsPanel.fallbackA")} <code>BETTER_AUTH_SECRET</code>
      {t("secretsPanel.withWarningConfigureADedicated")}
    </p>
  {/if}
</div>
