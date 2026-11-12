<script lang="ts">
  import { t } from "$lib/i18n";
  import { ArrowLeft, Save, Play } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast, Button, Card, Checkbox, Field, Input, Spinner, Textarea } from "$lib/tallao";

  import { api } from "$lib/api";

  interface Props {
    templateId?: string | null;
    /**
     * Back and Cancel. A kon mounts the form as a tab of its page and passes nothing: then
     * there is nowhere to go back to and the buttons are not drawn (they called an undefined
     * function).
     */
    onBack?: () => void;
    /** After a save; by default the form starts over, ready for the next one. */
    onSave?: () => void;
  }
  const { templateId = null, onBack, onSave }: Props = $props();

  let template = $state<any>({
    name: "",
    description: "",
    templateType: "",
    rules: [],
    requiredMetadata: [],
    isActive: true,
  });
  let loading = $state(false);
  let saving = $state(false);
  let rulesJson = $state("[]");
  let reqMetaJson = $state("[]");
  let testVariables = $state("{}");
  let testResult = $state<any>(null);
  let testLoading = $state(false);

  async function load() {
    if (!templateId) return;
    loading = true;
    try {
      const res = await api.getContaTemplate(templateId);
      // Missing or null fields stay "" (a bound `undefined` throws on mount).
      template = {
        name: "",
        description: "",
        templateType: "",
        rules: [],
        requiredMetadata: [],
        isActive: true,
        ...Object.fromEntries(
          Object.entries(res.data ?? {}).filter(([, v]) => v !== undefined && v !== null)
        ),
      };
      rulesJson = JSON.stringify(template.rules || [], null, 2);
      reqMetaJson = JSON.stringify(template.requiredMetadata || [], null, 2);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      loading = false;
    }
  }

  function parseJson<T>(str: string, fallback: T): T {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  async function save() {
    saving = true;
    try {
      const payload = {
        ...template,
        rules: parseJson(rulesJson, []),
        requiredMetadata: parseJson(reqMetaJson, []),
      };
      if (templateId) {
        await api.updateContaTemplate(templateId, payload);
      } else {
        await api.createContaTemplate(payload);
      }
      toast.success(t("templateForm.templateSaved"));
      onSave?.();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      saving = false;
    }
  }

  async function testApply() {
    if (!templateId) {
      toast.error(t("templateForm.saveTheTemplateFirst"));
      return;
    }
    testLoading = true;
    try {
      const variables = parseJson(testVariables, {});
      const res = await api.applyContaTemplate(templateId, variables);
      testResult = res.data;
      toast.success(t("templateForm.templateAppliedPreview"));
    } catch (e: any) {
      toast.error(e.message);
      testResult = null;
    } finally {
      testLoading = false;
    }
  }

  onMount(load);
</script>

<div class="space-y-6 min-w-0">
  {#if onBack}
    <Button variant="ghost" onclick={onBack}
      ><ArrowLeft class="w-4 h-4" /> {t("common.back")}</Button
    >
  {/if}

  {#if loading}
    <div class="flex items-center justify-center h-48"><Spinner size="lg" /></div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      <Field label={t("common.name")}>
        <Input bind:value={template.name} placeholder={t("templateForm.legalFeesWithTax")} />
      </Field>
      <Field label={t("templateForm.templateType")}>
        <Input bind:value={template.templateType} placeholder="legal_fees" />
      </Field>
      <Field label={t("common.description")} class="md:col-span-2">
        <Textarea bind:value={template.description} rows={2} />
      </Field>
      <div class="flex items-center">
        <Checkbox bind:checked={template.isActive} label={t("common.active")} />
      </div>
    </div>

    <div class="space-y-2">
      <Field label={t("templateForm.rulesJson")}>
        <Textarea bind:value={rulesJson} rows={10} mono />
      </Field>
      <p class="text-xs text-kitsuden-subtle">
        {t("templateForm.eachRule", {
          v: `{ "accountCode": "1200", "side": "debit|credit", "amountFormula": "total", "description": "..." }`,
        })}
      </p>
    </div>

    <Field label={t("templateForm.requiredMetadataJsonArray")}>
      <Textarea bind:value={reqMetaJson} rows={3} mono />
    </Field>

    {#if templateId}
      <Card class="p-4 space-y-3">
        <h3 class="text-sm font-semibold text-kitsuden-text flex items-center gap-2">
          <Play class="w-4 h-4" />
          {t("templateForm.testApply")}
        </h3>
        <div class="grid gap-3 md:grid-cols-2">
          <Field label={t("templateForm.variablesJson")}>
            <Textarea
              bind:value={testVariables}
              rows={4}
              mono
              placeholder={t("templateForm.total1000Taxrate007")}
            />
          </Field>
          <div class="min-w-0">
            <p class="text-sm font-medium text-kitsuden-text mb-1">
              {t("templateForm.previewResult")}
            </p>
            <div
              aria-live="polite"
              class="bg-kitsuden-card border border-kitsuden-border rounded-lg p-3 text-xs font-mono h-full min-h-[100px] overflow-auto"
            >
              {#if testLoading}
                <Spinner size="sm" />
              {:else if testResult}
                <pre>{JSON.stringify(testResult, null, 2)}</pre>
              {:else}
                <span class="text-kitsuden-subtle">{t("templateForm.clickTestToSeePreview")}</span>
              {/if}
            </div>
          </div>
        </div>
        <Button variant="secondary" size="sm" onclick={testApply} loading={testLoading}
          ><Play class="w-4 h-4" /> {t("templateForm.test")}</Button
        >
      </Card>
    {/if}

    <div
      class="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-kitsuden-border"
    >
      {#if onBack}
        <Button variant="secondary" onclick={onBack} disabled={saving}>{t("common.cancel")}</Button>
      {/if}
      <Button onclick={save} loading={saving}
        ><Save class="w-4 h-4" /> {t("templateForm.saveTemplate")}</Button
      >
    </div>
  {/if}
</div>
