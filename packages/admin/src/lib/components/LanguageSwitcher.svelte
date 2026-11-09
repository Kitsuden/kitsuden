<script lang="ts">
  /**
   * Panel language selector (English by default, Spanish optional).
   * Saves the choice and reloads: see `$lib/i18n/locale.svelte.ts`. tallao's Select.
   */
  import { t, getLocale, setLocale, type Language } from "$lib/i18n";
  import { Select } from "$lib/tallao";

  let { class: kind = "" }: { class?: string } = $props();

  function change(e: Event) {
    setLocale((e.currentTarget as HTMLSelectElement).value as Language);
  }
</script>

<Select
  size="sm"
  width="auto"
  class={kind}
  aria-label={t("languageSwitcher.language")}
  title={t("languageSwitcher.language")}
  value={getLocale()}
  onchange={change}
  data-testid="language-switcher"
  options={[
    { value: "en", label: t("languageSwitcher.english") },
    { value: "es", label: t("languageSwitcher.spanish") },
  ]}
/>
