<script lang="ts">
  import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/tallao";
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
    AlertCircle,
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
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
        <KeyRound class="w-5 h-5 text-kitsuden-accent" />
        {t("secretsPanel.secretsManager")}
      </h2>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("secretsPanel.encryptedWithAes256Gcm")}
        <code class="text-kitsuden-accent text-xs">process.env</code>
        {t("secretsPanel.withoutRestartingTheServer")}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        class="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-kitsuden-border text-kitsuden-text hover:border-kitsuden-accent/50 transition-colors disabled:opacity-50"
        onclick={reloadAll}
        disabled={busyKey === "__all__"}
      >
        <RefreshCw class="w-4 h-4 {busyKey === '__all__' ? 'animate-spin' : ''}" />
        {t("secretsPanel.reinjectAll")}
      </button>
      <button
        class="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/30 hover:bg-kitsuden-accent/20 transition-colors"
        onclick={() => (showForm = !showForm)}
      >
        <Plus class="w-4 h-4" />
        {t("secretsPanel.newSecret")}
      </button>
    </div>
  </div>

  <!-- Messages -->
  {#if error}
    <div
      class="flex items-center gap-2 p-3 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/30 text-kitsuden-accent-2 text-sm"
    >
      <AlertCircle class="w-4 h-4 shrink-0" />
      {error}
      <button class="ml-auto" onclick={() => (error = null)}><X class="w-4 h-4" /></button>
    </div>
  {/if}
  {#if successMsg}
    <div
      class="flex items-center gap-2 p-3 rounded-lg bg-kitsuden-green/10 border border-kitsuden-green/30 text-kitsuden-green text-sm"
    >
      <CheckCircle2 class="w-4 h-4 shrink-0" />
      {successMsg}
    </div>
  {/if}

  <!-- Create/rotate form -->
  {#if showForm}
    <div class="p-4 rounded-xl bg-kitsuden-card border border-kitsuden-border space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs text-kitsuden-subtle mb-1" for="secret-key"
            >{t("secretsPanel.keyUpperSnakeCase")}</label
          >
          <input
            id="secret-key"
            class="w-full px-3 py-2 text-sm rounded-lg bg-kitsuden-bg border {keyValid
              ? 'border-kitsuden-input'
              : 'border-kitsuden-accent-2'} text-kitsuden-text font-mono focus:border-kitsuden-accent outline-hidden"
            placeholder={t("secretsPanel.openaiApiKey")}
            bind:value={formKey}
          />
          {#if !keyValid}
            <p class="text-xs text-kitsuden-accent-2 mt-1">
              {t("secretsPanel.upperCaseUnderscoreFormat")}
            </p>
          {/if}
        </div>
        <div>
          <label class="block text-xs text-kitsuden-subtle mb-1" for="secret-value"
            >{t("secretsPanel.value")}</label
          >
          <div class="relative">
            {#if formShowValue}
              <input
                id="secret-value"
                type="text"
                class="w-full px-3 py-2 pr-10 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text font-mono focus:border-kitsuden-accent outline-hidden"
                placeholder="sk-..."
                bind:value={formValue}
              />
            {:else}
              <input
                id="secret-value"
                type="password"
                class="w-full px-3 py-2 pr-10 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text font-mono focus:border-kitsuden-accent outline-hidden"
                placeholder="sk-..."
                bind:value={formValue}
              />
            {/if}
            <button
              class="absolute right-2 top-1/2 -translate-y-1/2 text-kitsuden-subtle hover:text-kitsuden-text"
              onclick={() => (formShowValue = !formShowValue)}
              type="button"
            >
              {#if formShowValue}<EyeOff class="w-4 h-4" />{:else}<Eye class="w-4 h-4" />{/if}
            </button>
          </div>
        </div>
        <div>
          <label class="block text-xs text-kitsuden-subtle mb-1" for="secret-desc"
            >{t("secretsPanel.optionalDescription")}</label
          >
          <input
            id="secret-desc"
            class="w-full px-3 py-2 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text focus:border-kitsuden-accent outline-hidden"
            placeholder={t("secretsPanel.productionApiKeyOf")}
            bind:value={formDescription}
          />
        </div>
        <div class="flex items-end gap-4">
          <div class="flex-1">
            <label class="block text-xs text-kitsuden-subtle mb-1" for="secret-cat"
              >{t("secretsPanel.category")}</label
            >
            <select
              id="secret-cat"
              class="w-full px-3 py-2 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text focus:border-kitsuden-accent outline-hidden"
              bind:value={formCategory}
            >
              {#each categories as cat (cat)}
                <option value={cat}>{cat}</option>
              {/each}
            </select>
          </div>
          <label class="flex items-center gap-2 text-sm text-kitsuden-text pb-2 cursor-pointer">
            <input type="checkbox" bind:checked={formAutoInject} class="accent-[#a855f7]" />
            {t("secretsPanel.autoInjectAtBoot")}
          </label>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="px-4 py-2 text-sm rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/30 hover:bg-kitsuden-accent/20 transition-colors disabled:opacity-50"
          onclick={saveSecret}
          disabled={saving || !KEY_RE.test(formKey) || !formValue}
        >
          {saving ? t("secretsPanel.saving") : t("secretsPanel.saveAndInject")}
        </button>
        <button
          class="px-4 py-2 text-sm rounded-lg text-kitsuden-subtle hover:text-kitsuden-text transition-colors"
          onclick={() => (showForm = false)}
        >
          {t("common.cancel")}
        </button>
        <p class="text-xs text-kitsuden-subtle ml-auto">
          {t("secretsPanel.ifKeyAlreadyExists")}
        </p>
      </div>
    </div>
  {/if}

  <!-- List -->
  {#if loading}
    <div class="flex items-center justify-center py-12 text-kitsuden-subtle text-sm">
      <RefreshCw class="w-4 h-4 animate-spin mr-2" />
      {t("secretsPanel.loadingSecrets")}
    </div>
  {:else if secrets.length === 0}
    <div
      class="flex flex-col items-center justify-center py-12 rounded-xl border border-dashed border-kitsuden-border text-center"
    >
      <KeyRound class="w-8 h-8 text-kitsuden-subtle mb-3" />
      <p class="text-sm text-kitsuden-text font-medium">{t("secretsPanel.withoutSecretsYet")}</p>
      <p class="text-xs text-kitsuden-subtle mt-1 max-w-sm">
        {t("secretsPanel.createsYourFirstSecretAnd")}
        <code>process.env</code>
        {t("secretsPanel.instantlyWithoutTouchingFiles")}
      </p>
    </div>
  {:else}
    <div class="rounded-xl border border-kitsuden-border overflow-hidden">
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
                <span
                  class="px-2 py-0.5 rounded-full text-xs bg-kitsuden-purple/10 text-kitsuden-purple border border-kitsuden-purple/20"
                  >{s.category}</span
                >
              </TableCell>
              <TableCell>
                {#if s.autoInject}
                  <CheckCircle2 class="w-4 h-4 text-kitsuden-green" />
                {:else}
                  <span class="text-kitsuden-subtle text-xs">{t("secretsPanel.manual")}</span>
                {/if}
              </TableCell>
              <TableCell>{fmtDate(s.lastRotatedAt)}</TableCell>
              <TableCell>{fmtDate(s.lastInjectedAt)}</TableCell>
              <TableCell>
                <div class="flex items-center justify-end gap-1">
                  <button
                    class="p-1.5 rounded-lg text-kitsuden-accent hover:bg-kitsuden-accent/10 transition-colors disabled:opacity-40"
                    title={t("secretsPanel.injectIntoProcessEnvNow")}
                    onclick={() => injectSecret(s.key)}
                    disabled={busyKey === s.key}
                  >
                    <Zap class="w-4 h-4" />
                  </button>
                  {#if deleteTarget === s.key}
                    <button
                      class="px-2 py-1 rounded-lg text-xs bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border border-kitsuden-accent-2/30 hover:bg-kitsuden-accent-2/20"
                      onclick={() => deleteSecret(s.key)}
                      disabled={busyKey === s.key}
                    >
                      {t("secretsPanel.confirm")}
                    </button>
                    <button
                      class="p-1.5 rounded-lg text-kitsuden-subtle hover:text-kitsuden-text"
                      onclick={() => (deleteTarget = null)}
                    >
                      <X class="w-4 h-4" />
                    </button>
                  {:else}
                    <button
                      class="p-1.5 rounded-lg text-kitsuden-subtle hover:text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/10 transition-colors"
                      title={t("secretsPanel.removeDbProcessEnv")}
                      onclick={() => (deleteTarget = s.key)}
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  {/if}
                </div>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
    <p class="text-xs text-kitsuden-subtle">
      {t("secretsPanel.valuesAreNeverShown")} <code>KITSUDEN_SECRETS_KEY</code>
      {t("secretsPanel.fallbackA")} <code>BETTER_AUTH_SECRET</code>
      {t("secretsPanel.withWarningConfigureADedicated")}
    </p>
  {/if}
</div>
