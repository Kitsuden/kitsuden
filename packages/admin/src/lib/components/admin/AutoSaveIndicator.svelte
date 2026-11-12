<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save, Check, AlertCircle, ChevronDown } from "lucide-svelte";

  import { autosaveStore } from "$lib/states/autosave.svelte";
  import { Button, Popover } from "$lib/tallao";

  import VersionHistory from "./VersionHistory.svelte";

  let showDropdown = $state(false);

  function closeDropdown() {
    showDropdown = false;
  }
</script>

<!--
  The version history opens in tallao's Popover: anchored to the button, closed by Escape
  or a click outside, with focus back on the button.
-->
<Popover
  bind:open={showDropdown}
  placement="bottom-end"
  ariaLabel={t("versionHistory.versionHistory")}
  class="w-72"
>
  {#snippet trigger(props)}
    <Button {...props} variant="ghost" size="sm" data-testid="autosave-indicator">
      <!--
      ── WHY IT SAYS «DRAFT» AND NOT «SAVED» ─────────────────────────────────

      This indicator talks about the draft in THIS BROWSER (localStorage), not about
      what is saved on the server. Placed next to a «Save Post» button, a bare
      «Saved» says exactly the opposite of the truth: that the post is safe.
      And whoever reads it that way will close the tab without saving.

      The same goes for the other place that uses this indicator (`AutoFormModal`):
      there too it is a local draft.
    -->
      <span
        class="flex items-center gap-1.5 {autosaveStore.status === 'saving'
          ? 'text-kitsuden-amber'
          : autosaveStore.status === 'unsaved'
            ? 'text-kitsuden-accent-2'
            : 'text-kitsuden-green'}"
      >
        {#if autosaveStore.status === "saving"}
          <Save class="w-3.5 h-3.5 animate-pulse" />
          <span>{t("autoSaveIndicator.savingDraft")}</span>
        {:else if autosaveStore.status === "unsaved"}
          <AlertCircle class="w-3.5 h-3.5" />
          <span>{t("autoSaveIndicator.unsavedDraft")}</span>
        {:else}
          <Check class="w-3.5 h-3.5" />
          <span>{t("autoSaveIndicator.savedDraft")}</span>
        {/if}
      </span>
      <ChevronDown class="w-3 h-3 ml-0.5 transition-transform {showDropdown ? 'rotate-180' : ''}" />
    </Button>
  {/snippet}
  <VersionHistory onRestore={closeDropdown} />
</Popover>
