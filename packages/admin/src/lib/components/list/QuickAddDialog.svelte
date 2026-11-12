<!--
  Quick add from a list: the model's form in a dialog, for adding a record without leaving
  the list. Editing, history and everything else live on the record page. Cancel and Create
  sit in the dialog's footer, so they stay in sight however long the form is.
-->
<script lang="ts">
  import DynamicForm from "$lib/components/forms/DynamicForm.svelte";
  import { t } from "$lib/i18n";
  import type { RecordSource, Row } from "$lib/list/source";
  import { Alert, Button, Dialog, toast } from "$lib/tallao";

  interface Props {
    open?: boolean;
    source: RecordSource;
    onCreated?: (row: Row) => void;
  }
  let { open = $bindable(false), source, onCreated }: Props = $props();

  let error = $state<string | null>(null);
  let key = $state(0);
  let saving = $state(false);
  const formId = $props.id();

  async function create(values: Row) {
    if (saving) return;
    error = null;
    saving = true;
    try {
      const row = await source.create(values);
      toast.success(t("record.createdToast", { name: source.singular }));
      open = false;
      key += 1;
      onCreated?.(row);
    } catch (e) {
      error = (e as Error)?.message || t("record.saveFailed");
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={t("list.quickAddTitle", { name: source.singular })} size="lg">
  {#if error}
    <div class="mb-4"><Alert variant="error">{error}</Alert></div>
  {/if}
  {#key key}
    <DynamicForm fields={source.formFields} {formId} actions={false} onSubmit={create} />
  {/key}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("common.cancel")}</Button>
    <Button type="submit" form={formId} loading={saving}>{t("common.create")}</Button>
  {/snippet}
</Dialog>
