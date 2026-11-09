<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * Legacy redirector: this screen is served by `/g/[id]` with the generic
   * renderer, from the kon's `kon.json`.
   *
   * The destination was `/g/grimoire-directory`, an id from before the
   * grimoire -> kon rename: the kon is called `kon-directory`. For days it led to
   * an empty screen, and the link probe did not see it because
   * `/g/grimoire-directory` fits the `/g/[id]` route perfectly — the id
   * can be anything. It only failed on click.
   */
  import { onMount } from "svelte";

  import { goto } from "$app/navigation";

  onMount(() => {
    goto("/g/kon-directory");
  });
</script>

<div class="flex items-center justify-center h-96">
  <div class="flex flex-col items-center gap-4">
    <div
      class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
    ></div>
    <p class="text-kitsuden-subtle text-sm">{t("directoryPage.redirectingToGrimoireDirectory")}</p>
  </div>
</div>
