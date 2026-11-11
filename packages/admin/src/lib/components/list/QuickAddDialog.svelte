<!--
  Quick add from a list: the model's form in a dialog, for adding a record without leaving
  the list. Editing, history and everything else live on the record page.
-->
<script lang="ts">
  import DynamicForm from "$lib/components/forms/DynamicForm.svelte";
  import { t } from "$lib/i18n";
  import type { RecordSource, Row } from "$lib/list/source";
  import { Alert, Dialog, toast } from "$lib/tallao";

  interface Props {
    open?: boolean;
    source: RecordSource;
    onCreated?: (row: Row) => void;
  }
  let { open = $bindable(false), source, onCreated }: Props = $props();

  let error = $state<string | null>(null);
  let key = $state(0);

  async function create(values: Row) {
    error = null;
    try {
      const row = await source.create(values);
      toast.success(t("record.createdToast", { name: source.singular }));
      open = false;
      key += 1;
      onCreated?.(row);
    } catch (e) {
      error = (e as Error)?.message || t("record.saveFailed");
    }
  }
</script>

<Dialog bind:open title={t("list.quickAddTitle", { name: source.singular })} size="lg">
  {#if error}
    <div class="mb-4"><Alert variant="error">{error}</Alert></div>
  {/if}
  {#key key}
    <DynamicForm
      fields={source.formFields}
      submitLabel={t("common.create")}
      onSubmit={create}
      onCancel={() => (open = false)}
    />
  {/key}
</Dialog>
