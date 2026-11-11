<script lang="ts">
  import { t } from "$lib/i18n";
  import { ArrowLeft, Save, Play } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { api } from "$lib/api";
  import Button from "$lib/components/ui/Button.svelte";
  import Input from "$lib/components/ui/Input.svelte";
  import Label from "$lib/components/ui/Label.svelte";
  import Textarea from "$lib/components/ui/Textarea.svelte";

  interface Props {
    templateId?: string | null;
    onBack: () => void;
    onSave: () => void;
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
      template = res.data;
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
      onSave();
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

<div class="space-y-6">
  <Button variant="ghost" onclick={onBack}
    ><ArrowLeft class="w-4 h-4 mr-2" /> {t("common.back")}</Button
  >

  {#if loading}
    <div class="flex items-center justify-center h-48">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-kitsuden-accent"></div>
    </div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      <div>
        <Label>{t("common.name")}</Label><Input
          bind:value={template.name}
          placeholder={t("templateForm.legalFeesWithTax")}
        />
      </div>
      <div>
        <Label>{t("templateForm.templateType")}</Label><Input
          bind:value={template.templateType}
          placeholder="legal_fees"
        />
      </div>
      <div class="md:col-span-2">
        <Label>{t("common.description")}</Label><Textarea
          bind:value={template.description}
          rows={2}
        />
      </div>
      <div>
        <Label>{t("common.active")}</Label>
        <select
          bind:value={template.isActive}
          class="w-full bg-kitsuden-card border border-kitsuden-input rounded-lg px-3 py-2 text-sm"
        >
          <option value={true as any}>{t("common.yes")}</option>
          <option value={false as any}>{t("common.no")}</option>
        </select>
      </div>
    </div>

    <div class="space-y-2">
      <Label>{t("templateForm.rulesJson")}</Label>
      <Textarea bind:value={rulesJson} rows={10} class="font-mono text-xs" />
      <p class="text-xs text-kitsuden-subtle">
        {t("templateForm.eachRule", {
          v: `{ "accountCode": "1200", "side": "debit|credit", "amountFormula": "total", "description": "..." }`,
        })}
      </p>
    </div>

    <div class="space-y-2">
      <Label>{t("templateForm.requiredMetadataJsonArray")}</Label>
      <Textarea bind:value={reqMetaJson} rows={3} class="font-mono text-xs" />
    </div>

    {#if templateId}
      <div class="border border-kitsuden-border rounded-lg p-4 space-y-3">
        <h3 class="text-sm font-semibold text-kitsuden-text flex items-center gap-2">
          <Play class="w-4 h-4" />
          {t("templateForm.testApply")}
        </h3>
        <div class="grid gap-3 md:grid-cols-2">
          <div>
            <Label class="text-xs">{t("templateForm.variablesJson")}</Label>
            <Textarea
              bind:value={testVariables}
              rows={4}
              class="font-mono text-xs"
              placeholder={t("templateForm.total1000Taxrate007")}
            />
          </div>
          <div>
            <Label class="text-xs">{t("templateForm.previewResult")}</Label>
            <div
              class="bg-kitsuden-card border border-kitsuden-border rounded-lg p-3 text-xs font-mono h-full min-h-[100px] overflow-auto"
            >
              {#if testLoading}
                <div
                  class="animate-spin rounded-full h-4 w-4 border-b-2 border-kitsuden-accent"
                ></div>
              {:else if testResult}
                <pre>{JSON.stringify(testResult, null, 2)}</pre>
              {:else}
                <span class="text-kitsuden-subtle">{t("templateForm.clickTestToSeePreview")}</span>
              {/if}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onclick={testApply} loading={testLoading}
          ><Play class="w-4 h-4 mr-2" /> {t("templateForm.test")}</Button
        >
      </div>
    {/if}

    <div class="flex items-center justify-between pt-4 border-t border-kitsuden-border">
      <Button variant="outline" onclick={onBack} disabled={saving}>{t("common.cancel")}</Button>
      <Button onclick={save} loading={saving}
        ><Save class="w-4 h-4 mr-2" /> {t("templateForm.saveTemplate")}</Button
      >
    </div>
  {/if}
</div>
