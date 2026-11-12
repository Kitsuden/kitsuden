<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { t } from "$lib/i18n";
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    Field,
    Input,
    NumberInput,
    SaveBar,
    Select,
    Slider,
    Spinner,
    toast,
  } from "$lib/tallao";
  /**
   * VisionConfigView — Vision LLM settings (kon-ocr-training).
   *
   * Governs the "last resort" of VekDocs's OCR cascade: when to escalate
   * to a vision LLM and with which provider/model. The provider API key is NOT
   * edited here — it lives in KITSUDEN Secrets (encrypted); this panel only shows whether
   * it is present and lets you test the connection.
   */
  import { Plug } from "lucide-svelte";

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
  let loadError = $state("");
  let saveError = $state<string | undefined>(undefined);
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
  /** The form as it was loaded or last saved: what "unsaved changes" compares against. */
  let baseline = $state("");
  const dirty = $derived(baseline !== "" && JSON.stringify(form) !== baseline);

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(`${API_URL}${path}`, { credentials: "include", ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  }

  async function load() {
    loading = true;
    loadError = "";
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
      baseline = JSON.stringify(form);
    } catch (e: any) {
      loadError = t("visionConfigView.errorLoading", { v: e.message });
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    saveError = undefined;
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
      baseline = JSON.stringify(form);
      toast.success(t("common.saved"));
    } catch (e: any) {
      saveError = t("visionConfigView.errorSaving", { v: e.message });
    } finally {
      saving = false;
    }
  }

  function discard() {
    if (baseline) form = JSON.parse(baseline);
    saveError = undefined;
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

<ViewPage
  title={t("visionConfigView.visionLlmAiSettings")}
  description={t("visionConfigView.lastCascadeResource")}
>
  {#if loading}
    <div class="flex justify-center py-16">
      <Spinner size="lg" />
    </div>
  {:else}
    <div class="flex max-w-4xl flex-col gap-4">
      {#if loadError}
        <Alert variant="error">{loadError}</Alert>
      {/if}
      <div class="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_1.3fr]">
        <!-- Credential (KITSUDEN Secrets) -->
        <Card>
          <CardHeader>
            <CardTitle level={2}>{t("visionConfigView.providerCredential")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex flex-col items-start gap-3">
              {#if cfg?.api_key_present}
                <Badge variant="success" dot
                  >{t("visionConfigView.keyPresentInKitsudenSecrets")}</Badge
                >
              {:else}
                <Badge variant="warning" dot>{t("visionConfigView.withoutConfiguredKey")}</Badge>
              {/if}
              <p class="text-sm text-kitsuden-text-dim">
                {t("visionConfigView.theApiKeyIsSaved")}
                <strong>{t("visionConfigView.kitsudenSecrets")}</strong>
                {t("visionConfigView.encryptedNotHereAddItAs")}
                <code class="break-all text-xs">VEKOCR_VISION_LLM_API_KEY</code>
                {t("visionConfigView.fromTheSection")}
                <em>{t("visionConfigView.secrets")}</em>{t(
                  "visionConfigView.neverLeavesKitsudenNo"
                )}
              </p>
              <Button
                variant="secondary"
                onclick={testConnection}
                loading={testing}
                disabled={testing || !cfg?.api_key_present}
              >
                <Plug size={14} aria-hidden="true" />
                {t("visionConfigView.testConnection")}
              </Button>
              {#if testResult}
                <Alert variant={testResult.ok ? "success" : "error"} class="w-full">
                  {testResult.text}
                </Alert>
              {/if}
            </div>
          </CardContent>
        </Card>

        <!-- Behavior config -->
        <Card>
          <CardHeader>
            <CardTitle level={2}>{t("visionConfigView.behavior")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex flex-col gap-4">
              <Checkbox
                bind:checked={form.enabled}
                label={t("visionConfigView.activateVisionLlm")}
              />

              <Field label={t("visionConfigView.provider")}>
                <Select
                  bind:value={form.provider}
                  options={[
                    {
                      value: "anthropic",
                      label: t("visionConfigView.anthropicClaudeSupportsNativePdf"),
                    },
                    {
                      value: "openai",
                      label: t("visionConfigView.openaiCompatibleOpenaiOpenrouterLocal"),
                    },
                  ]}
                />
              </Field>

              <Field label={t("common.model")}>
                <Input
                  bind:value={form.model}
                  placeholder={providerDefaults[form.provider] ??
                    t("visionConfigView.providerDefault")}
                />
              </Field>

              <Field
                label={`${t("visionConfigView.baseUrl")} ${t("visionConfigView.optionalGatewaysLocal")}`}
              >
                <Input
                  bind:value={form.base_url}
                  placeholder={t("visionConfigView.pEjHttpHostDocker")}
                />
              </Field>

              <div class="flex flex-col gap-1">
                <Slider
                  bind:value={form.min_confidence_pct}
                  min={0}
                  max={99}
                  step={1}
                  label={t("visionConfigView.fidelityThreshold")}
                  valueText={(v) => (v === 0 ? t("visionConfigView.gateNormal") : `${v}%`)}
                />
                <p class="text-xs text-kitsuden-subtle">{t("visionConfigView.ifOcrFallsBelow")}</p>
              </div>

              <Field label={t("visionConfigView.whenStandaloneEngineEnters")}>
                <Select
                  bind:value={form.stage}
                  options={[
                    { value: "after_heavy", label: t("visionConfigView.afterHeavyOcrMinimum") },
                    { value: "after_light", label: t("visionConfigView.afterLightOcrSkips") },
                  ]}
                />
              </Field>

              <div class="flex flex-col gap-1">
                <Field label={t("visionConfigView.maxPagesPerDocument")}>
                  <NumberInput
                    value={form.max_pages}
                    min={1}
                    max={20}
                    onchange={(v) => (form.max_pages = v ?? 1)}
                  />
                </Field>
                <p class="text-xs text-kitsuden-subtle">
                  {t("visionConfigView.costControlTheLlm")}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <SaveBar
        {dirty}
        {saving}
        error={saveError}
        disableWhenClean
        saveLabel={t("visionConfigView.save")}
        savedText={t("common.saved")}
        onSave={save}
        onCancel={dirty ? discard : undefined}
      />
    </div>
  {/if}
</ViewPage>
