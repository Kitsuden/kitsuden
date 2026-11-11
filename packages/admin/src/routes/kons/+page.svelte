<!--
  Kons: the installable modules, and the grimoires (sets of kons that form a product) as a
  second tab. /grimoires lands on that tab.
-->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import { t } from "$lib/i18n";
  import { queryChoice, setQuery } from "$lib/page";
  import { Tabs, type TabItem } from "$lib/tallao";
  import GrimoiresView from "$views/grimoires/GrimoiresView.svelte";
  import Kons from "$views/Kons.svelte";

  import { page } from "$app/stores";

  const TABS = ["kons", "grimoires"] as const;
  const active = $derived(queryChoice($page.url, "tab", TABS, "kons"));
  const items = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: id === "kons" ? t("shell.kons") : t("shell.grimoires"),
      controls: "kons-panel",
      tabId: `kons-tab-${id}`,
    }))
  );
  const select = (tab: string) => void setQuery($page.url, { tab: tab === "kons" ? null : tab });
</script>

<Page
  title={t("shell.kons")}
  description={active === "kons"
    ? t("kons.manageSystemKonsUninstallTo")
    : t("grimoiresView.manageBusinessEcosystemsThatGroup")}
>
  {#snippet tabs()}
    <Tabs {items} bind:value={() => active, select} panels={false} ariaLabel={t("shell.kons")} />
  {/snippet}

  <div id="kons-panel" role="tabpanel" aria-labelledby="kons-tab-{active}">
    {#if active === "grimoires"}
      <GrimoiresView />
    {:else}
      <Kons />
    {/if}
  </div>
</Page>
