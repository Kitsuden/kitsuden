<!--
  The panel's single confirmation dialog (see $lib/confirm.svelte.ts). Mounted once in the
  root layout.
-->
<script lang="ts">
  import { pendingConfirm, settleConfirm, type ConfirmOptions } from "$lib/confirm.svelte";
  import { t } from "$lib/i18n";
  import { ConfirmDialog } from "$lib/tallao";

  const pending = $derived(pendingConfirm());
  // The last request stays rendered while the dialog closes, so its text does not blank out.
  let shown = $state<ConfirmOptions | null>(null);
  let open = $state(false);

  $effect(() => {
    if (pending) {
      shown = pending;
      open = true;
    } else {
      open = false;
    }
  });
</script>

{#if shown}
  <ConfirmDialog
    bind:open
    title={shown.title}
    description={shown.description}
    confirmLabel={shown.confirmLabel ?? t("common.confirm")}
    cancelLabel={shown.cancelLabel ?? t("common.cancel")}
    variant={shown.variant ?? "danger"}
    onConfirm={() => settleConfirm(true)}
    onCancel={() => settleConfirm(false)}
  />
{/if}
