<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * VisionConfigView — Vision LLM settings (kon-ocr-training).
   *
   * Governs the "last resort" of VekDocs's OCR cascade: when to escalate
   * to a vision LLM and with which provider/model. The provider API key is NOT
   * edited here — it lives in KITSUDEN Secrets (encrypted); this panel only shows whether
   * it is present and lets you test the connection.
   */
  import { Sparkles, KeyRound, CheckCircle2, XCircle, Loader2, Save, Plug } from "lucide-svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  type Config = {
    enabled: boolean;
    provider: string;
    model: string;
    base_url: string | null;
    min_confidence: number | null;
    stage: string;
    max_pages: number;
    api_key_present: boolean;
    api_key_source: string;
  };

  let cfg = $state<Config | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let msg = $state("");
  let testResult = $state<{ ok: boolean; text: string } | null>(null);

  // Editable mirror (the threshold slider is handled in %).
  let form = $state({
    enabled: false,
    provider: "anthropic",
    model: "",
    base_url: "",
    min_confidence_pct: 0, // 0 = use normal gate
    stage: "after_heavy",
    max_pages: 3,
  });

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(`${API_URL}${path}`, { credentials: "include", ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  }

  async function load() {
    loading = true;
    msg = "";
    try {
      cfg = await api("/api/ocr-training/vision-config");
      form = {
        enabled: cfg!.enabled,
        provider: cfg!.provider,
        model: cfg!.model ?? "",
        base_url: cfg!.base_url ?? "",
        min_confidence_pct: cfg!.min_confidence != null ? Math.round(cfg!.min_confidence * 100) : 0,
        stage: cfg!.stage,
        max_pages: cfg!.max_pages,
      };
    } catch (e: any) {
      msg = t("visionConfigView.errorLoading", { v: e.message });
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    msg = "";
    try {
      const payload = {
        enabled: form.enabled,
        provider: form.provider,
        model: form.model.trim() || null,
        base_url: form.base_url.trim() || null,
        min_confidence: form.min_confidence_pct > 0 ? form.min_confidence_pct / 100 : null,
        stage: form.stage,
        max_pages: form.max_pages,
      };
      cfg = await api("/api/ocr-training/vision-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      msg = "✓ Saved";
    } catch (e: any) {
      msg = t("visionConfigView.errorSaving", { v: e.message });
    } finally {
      saving = false;
    }
  }

  async function testConnection() {
    testing = true;
    testResult = null;
    try {
      const r = await api("/api/ocr-training/vision-config/test", { method: "POST" });
      testResult = {
        ok: !!r.ok,
        text: r.ok
          ? t("visionConfigView.connectionOk", { model: r.model })
          : t("visionConfigView.failure", { status: r.error || r.status }),
      };
    } catch (e: any) {
      testResult = { ok: false, text: e.message };
    } finally {
      testing = false;
    }
  }

  $effect(() => {
    load();
  });

  const providerDefaults: Record<string, string> = {
    anthropic: "claude-sonnet-4-5",
    openai: "gpt-4o",
  };
</script>

<div class="vc-page">
  <header class="vc-head">
    <div class="vc-title">
      <Sparkles size={20} />
      <div>
        <h1>{t("visionConfigView.visionLlmAiSettings")}</h1>
        <p>{t("visionConfigView.lastCascadeResource")}</p>
      </div>
    </div>
  </header>

  {#if loading}
    <div class="vc-loading"><Loader2 size={18} class="spin" /> {t("common.loadingEllipsis")}</div>
  {:else}
    <div class="vc-grid">
      <!-- Credential (KITSUDEN Secrets) -->
      <section class="vc-card vc-secret">
        <div class="vc-card-head">
          <KeyRound size={16} />
          {t("visionConfigView.providerCredential")}
        </div>
        <div class="vc-card-body">
          {#if cfg?.api_key_present}
            <div class="vc-badge ok">
              <CheckCircle2 size={14} />
              {t("visionConfigView.keyPresentInKitsudenSecrets")}
            </div>
          {:else}
            <div class="vc-badge warn">
              <XCircle size={14} />
              {t("visionConfigView.withoutConfiguredKey")}
            </div>
          {/if}
          <p class="vc-note">
            {t("visionConfigView.theApiKeyIsSaved")}
            <strong>{t("visionConfigView.kitsudenSecrets")}</strong>
            {t("visionConfigView.encryptedNotHereAddItAs")} <code>VEKOCR_VISION_LLM_API_KEY</code>
            {t("visionConfigView.fromTheSection")}
            <em>{t("visionConfigView.secrets")}</em>{t("visionConfigView.neverLeavesKitsudenNo")}
          </p>
          <button
            class="vc-btn ghost"
            onclick={testConnection}
            disabled={testing || !cfg?.api_key_present}
          >
            {#if testing}<Loader2 size={14} class="spin" />{:else}<Plug size={14} />{/if}
            {t("visionConfigView.testConnection")}
          </button>
          {#if testResult}
            <div class="vc-badge {testResult.ok ? 'ok' : 'err'}" style="margin-top:8px">
              {#if testResult.ok}<CheckCircle2 size={14} />{:else}<XCircle size={14} />{/if}
              {testResult.text}
            </div>
          {/if}
        </div>
      </section>

      <!-- Behavior config -->
      <section class="vc-card">
        <div class="vc-card-head">{t("visionConfigView.behavior")}</div>
        <div class="vc-card-body">
          <label class="vc-switch">
            <input type="checkbox" bind:checked={form.enabled} />
            <span>{t("visionConfigView.activateVisionLlm")}</span>
          </label>

          <div class="vc-field">
            <span class="vc-label">{t("visionConfigView.provider")}</span>
            <select bind:value={form.provider}>
              <option value="anthropic"
                >{t("visionConfigView.anthropicClaudeSupportsNativePdf")}</option
              >
              <option value="openai"
                >{t("visionConfigView.openaiCompatibleOpenaiOpenrouterLocal")}</option
              >
            </select>
          </div>

          <div class="vc-field">
            <span class="vc-label">{t("common.model")}</span>
            <input
              type="text"
              bind:value={form.model}
              placeholder={providerDefaults[form.provider] ?? t("visionConfigView.providerDefault")}
            />
          </div>

          <div class="vc-field">
            <span class="vc-label"
              >{t("visionConfigView.baseUrl")}
              <em>{t("visionConfigView.optionalGatewaysLocal")}</em></span
            >
            <input
              type="text"
              bind:value={form.base_url}
              placeholder={t("visionConfigView.pEjHttpHostDocker")}
            />
          </div>

          <div class="vc-field">
            <span class="vc-label">
              {t("visionConfigView.fidelityThreshold")}
              <strong
                >{form.min_confidence_pct === 0
                  ? t("visionConfigView.gateNormal")
                  : form.min_confidence_pct + "%"}</strong
              >
            </span>
            <input type="range" min="0" max="99" step="1" bind:value={form.min_confidence_pct} />
            <span class="vc-hint">{t("visionConfigView.ifOcrFallsBelow")}</span>
          </div>

          <div class="vc-field">
            <span class="vc-label">{t("visionConfigView.whenStandaloneEngineEnters")}</span>
            <select bind:value={form.stage}>
              <option value="after_heavy">{t("visionConfigView.afterHeavyOcrMinimum")}</option>
              <option value="after_light">{t("visionConfigView.afterLightOcrSkips")}</option>
            </select>
          </div>

          <div class="vc-field">
            <span class="vc-label">{t("visionConfigView.maxPagesPerDocument")}</span>
            <input type="number" min="1" max="20" bind:value={form.max_pages} />
            <span class="vc-hint">{t("visionConfigView.costControlTheLlm")}</span>
          </div>
        </div>
      </section>
    </div>

    <div class="vc-actions">
      <button class="vc-btn primary" onclick={save} disabled={saving}>
        {#if saving}<Loader2 size={14} class="spin" />{:else}<Save size={14} />{/if}
        {t("visionConfigView.save")}
      </button>
      {#if msg}<span class="vc-msg" class:err={msg.startsWith("Error")}>{msg}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .vc-page {
    padding: 20px;
    max-width: 900px;
  }
  .vc-head {
    margin-bottom: 18px;
  }
  .vc-title {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .vc-title h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }
  .vc-title p {
    font-size: 12px;
    opacity: 0.7;
    margin: 2px 0 0;
  }
  .vc-loading {
    display: flex;
    gap: 8px;
    align-items: center;
    opacity: 0.7;
    padding: 40px 0;
  }
  .vc-grid {
    display: grid;
    grid-template-columns: 1fr 1.3fr;
    gap: 16px;
  }
  @media (max-width: 780px) {
    .vc-grid {
      grid-template-columns: 1fr;
    }
  }
  .vc-card {
    border: 1px solid var(--kitsuden-border, #2a2a2a);
    border-radius: 8px;
    overflow: hidden;
    background: var(--kitsuden-card, #17171a);
  }
  .vc-secret {
    align-self: start;
  }
  .vc-card-head {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.75;
    border-bottom: 1px solid var(--kitsuden-border, #2a2a2a);
  }
  .vc-card-body {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .vc-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .vc-label {
    font-size: 12px;
    opacity: 0.85;
  }
  .vc-label em {
    opacity: 0.6;
    font-style: italic;
  }
  .vc-hint {
    font-size: 11px;
    opacity: 0.55;
  }
  .vc-field input[type="text"],
  .vc-field input[type="number"],
  .vc-field select {
    background: var(--kitsuden-bg, #0e0e10);
    border: 1px solid var(--kitsuden-border, #333);
    color: inherit;
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 13px;
    width: 100%;
  }
  .vc-field input[type="range"] {
    width: 100%;
  }
  .vc-switch {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    cursor: pointer;
  }
  .vc-note {
    font-size: 12px;
    opacity: 0.7;
    line-height: 1.5;
  }
  .vc-note code {
    background: rgba(255, 255, 255, 0.08);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
  }
  .vc-badge {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 20px;
    width: fit-content;
  }
  .vc-badge.ok {
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
  }
  .vc-badge.warn {
    background: rgba(245, 158, 11, 0.12);
    color: #f59e0b;
  }
  .vc-badge.err {
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
  }
  .vc-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 16px;
  }
  .vc-btn {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .vc-btn.primary {
    background: var(--kitsuden-accent, #0078d4);
    color: #fff;
  }
  .vc-btn.ghost {
    background: transparent;
    border-color: var(--kitsuden-border, #333);
    color: inherit;
  }
  .vc-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .vc-msg {
    font-size: 12px;
    opacity: 0.8;
  }
  .vc-msg.err {
    color: #ef4444;
  }
  :global(.spin) {
    animation: vc-spin 0.7s linear infinite;
  }
  @keyframes vc-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
