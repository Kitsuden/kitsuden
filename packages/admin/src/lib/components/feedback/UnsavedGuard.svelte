<!--
  Warns before leaving a page with unsaved changes.

  Inside the panel: `beforeNavigate` cancels the navigation and asks with the panel's
  dialog; on "Leave" it repeats the navigation. Closing the tab or reloading: the browser's
  own `beforeunload` prompt (the only thing a page may show there).
-->
<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t } from "$lib/i18n";

  import { beforeNavigate, goto } from "$app/navigation";

  let {
    dirty,
    message,
    watchParam,
  }: {
    dirty: boolean;
    message?: string;
    /**
     * A query parameter whose change also discards the work (a tab that unmounts the form).
     * Without it, moving within the same page is never guarded.
     */
    watchParam?: string;
  } = $props();

  let leaving = false;

  beforeNavigate((nav) => {
    if (!dirty || leaving) return;
    // Leaving the document: the browser asks by itself once `cancel()` is called.
    if (nav.willUnload || !nav.to) {
      nav.cancel();
      return;
    }
    // The same page with another query: nothing is lost, unless the parameter that
    // unmounts this form (`watchParam`, a tab) is the one changing.
    if (nav.from && nav.to.url.pathname === nav.from.url.pathname) {
      const same =
        !watchParam ||
        nav.to.url.searchParams.get(watchParam) === nav.from.url.searchParams.get(watchParam);
      if (same) return;
    }
    nav.cancel();
    const target = nav.to.url;
    void confirmDialog({
      title: t("unsaved.title"),
      description: message ?? t("unsaved.description"),
      confirmLabel: t("unsaved.leave"),
      cancelLabel: t("unsaved.stay"),
    }).then(async (ok) => {
      if (!ok) return;
      leaving = true;
      try {
        await goto(target);
      } finally {
        leaving = false;
      }
    });
  });

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  }
</script>

<svelte:window onbeforeunload={onBeforeUnload} />
