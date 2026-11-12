<script lang="ts">
  import { Badge, Button, Card, CardContent, CardFooter, Spinner, toast } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { Castle, Plus } from "lucide-svelte";
  import { onMount } from "svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  interface Grimoire {
    id: string;
    name: string;
    description?: string;
    version?: string;
    isActive?: boolean;
    kons: {
      required: string[];
      optional: string[];
      installedCount: number;
      enabledCount: number;
    };
    canDelete?: boolean;
  }
  import { applyGrimoireTheme, resetGrimoireTheme } from "$lib/theme.svelte";

  let grimoires = $state<Grimoire[]>([]);
  let loading = $state(true);
  let activeGrimoire = $state<string | null>(null);

  async function fetchGrimoires() {
    try {
      loading = true;
      const res = await fetch(`${API_URL}/api/system/grimoires`, { credentials: "include" });
      if (res.ok) {
        grimoires = await res.json();
      }
      const settingsRes = await fetch(`${API_URL}/api/settings`, { credentials: "include" });
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        activeGrimoire = settings.activeGrimoire || settings.activeTheme || null;
      }
    } catch (err) {
      console.error("Failed to fetch grimoires:", err);
      grimoires = [
        {
          id: "grimoire-default",
          name: "Default",
          description: t("grimoiresView.basicCmsFunctionalityWithoutSpecialized"),
          kons: { required: [], optional: [], installedCount: 0, enabledCount: 0 },
        },
        {
          id: "grimoire-corporate",
          name: "Corporate",
          description: t("grimoiresView.enterpriseFeaturesWithCrmDocument"),
          kons: {
            required: ["kon-crm"],
            optional: [],
            installedCount: 0,
            enabledCount: 0,
          },
        },
      ];
    } finally {
      loading = false;
    }
  }

  async function activateGrimoire(grimoireId: string) {
    try {
      const res = await fetch(`${API_URL}/api/system/grimoire-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "activate", grimoireId }),
      });
      if (res.ok) {
        activeGrimoire = grimoireId;
        await fetchGrimoires();
        await applyGrimoireTheme(); // refreshes the panel visuals live
      }
    } catch (err) {
      console.error("Failed to activate grimoire:", err);
      toast.error(t("grimoiresView.failedToActivateGrimoirePlease"));
    }
  }

  async function deactivateGrimoire() {
    try {
      const res = await fetch(`${API_URL}/api/system/grimoire-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "deactivate" }),
      });
      if (res.ok) {
        activeGrimoire = null;
        await fetchGrimoires();
        resetGrimoireTheme(); // restores the style.css defaults without reloading
      }
    } catch (err) {
      console.error("Failed to deactivate grimoire:", err);
      toast.error(t("grimoiresView.failedToDeactivateGrimoirePlease"));
    }
  }

  onMount(() => {
    fetchGrimoires();
  });

  function getKonIcon(kon: string): string {
    const icons: Record<string, string> = {
      "kon-games": "🎮",
      "kon-streamers": "📡",
      "kon-platforms": "🖥️",
      "kon-tags": "🏷️",
      "kon-collections": "📚",
      "kon-actions": "⚡",
      "kon-academy-lms": "🎓",
      "kon-booking": "📅",
      "kon-directory": "👥",
      "kon-dms": "📄",
      "kon-blog": "📝",
      "kon-crm": "💼",
      "kon-media": "🖼️",
      "kon-blocks": "🧱",
      "kon-datasets": "🗂️",
    };
    return icons[kon] || "📦";
  }

  function getKonName(kon: string): string {
    return kon.replace(/^kon-/, "");
  }

  function allKons(grimoire: Grimoire): string[] {
    return [...(grimoire.kons?.required || []), ...(grimoire.kons?.optional || [])];
  }
</script>

<div class="grimoires">
  {#if loading}
    <Card>
      <CardContent class="grimoires-loading">
        <Spinner size="lg" label={t("grimoiresView.loadingGrimoires")} />
        <p>{t("grimoiresView.loadingGrimoires")}</p>
      </CardContent>
    </Card>
  {:else}
    <div class="grimoires-grid">
      {#each grimoires as grimoire}
        {@const kons = allKons(grimoire)}
        {@const active = activeGrimoire === grimoire.id}
        <Card class={active ? "grimoire grimoire--on" : "grimoire"}>
          <CardContent class="grimoire-body">
            <div class="grimoire-head">
              <div class="grimoire-icon" aria-hidden="true">
                <Castle size={24} />
              </div>
              <div class="grimoire-title">
                <h3>{grimoire.name}</h3>
                <p>{t("grimoiresView.konsIncluded", { konsCount: kons.length })}</p>
              </div>
              {#if active}
                <Badge variant="accent" dot>{t("common.active")}</Badge>
              {/if}
            </div>

            <p class="grimoire-desc">
              {grimoire.description || t("grimoiresView.noDescriptionAvailable")}
            </p>

            <div>
              <p class="grimoire-label">{t("grimoiresView.includedKons")}</p>
              <div class="grimoire-kons">
                {#each kons.slice(0, 6) as kon}
                  <Badge>
                    <span aria-hidden="true">{getKonIcon(kon)}</span>
                    {getKonName(kon)}
                  </Badge>
                {/each}
                {#if kons.length > 6}
                  <Badge variant="secondary">{t("common.more", { v: kons.length - 6 })}</Badge>
                {/if}
              </div>
            </div>
          </CardContent>

          <!-- Activating is the primary move; deactivating stays quiet. -->
          <CardFooter class="grimoire-actions">
            {#if active}
              <Button variant="danger-ghost" size="sm" onclick={() => deactivateGrimoire()}>
                {t("grimoiresView.deactivate")}
              </Button>
            {:else}
              <Button size="sm" onclick={() => activateGrimoire(grimoire.id)}>
                {t("common.activate")}
              </Button>
            {/if}
            <!-- There was a "view details" button with no action: there is no detail screen. -->
          </CardFooter>
        </Card>
      {/each}

      <!--
        Create Custom Grimoire Card. It did nothing when clicked; putting together a
        custom ecosystem IS activating kons one by one, so it leads to Kons.
      -->
      <a href="/kons" class="grimoire-new">
        <span class="grimoire-icon" aria-hidden="true"><Plus size={24} /></span>
        <span class="grimoire-new-title">{t("grimoiresView.createCustomGrimoire")}</span>
        <span class="grimoire-new-text">{t("grimoiresView.buildYourOwnEcosystemBy")}</span>
      </a>
    </div>
  {/if}
</div>

<style>
  .grimoires {
    min-width: 0;
  }
  :global(.grimoires-loading) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding-block: 3rem;
    color: rgb(var(--ta-text-dim));
  }
  :global(.grimoires-loading p) {
    margin: 0;
  }
  .grimoires-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
  }
  :global(.grimoire) {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  :global(.grimoire--on) {
    border-color: rgb(var(--ta-accent) / 0.45);
  }
  :global(.grimoire-body) {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .grimoire-head {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }
  .grimoire-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 3rem;
    height: 3rem;
    border-radius: var(--ta-radius-lg);
    background: rgb(var(--ta-accent) / 0.1);
    color: rgb(var(--ta-accent));
  }
  .grimoire-title {
    flex: 1;
    min-width: 0;
  }
  .grimoire-title h3 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .grimoire-title p,
  .grimoire-label {
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .grimoire-label {
    margin: 0 0 0.5rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .grimoire-desc {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .grimoire-kons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  :global(.ta-card-footer.grimoire-actions) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .grimoire-new {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: 16rem;
    padding: 1.25rem;
    text-align: center;
    text-decoration: none;
    color: inherit;
    border: 2px dashed rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    transition: border-color 150ms;
  }
  .grimoire-new:hover,
  .grimoire-new:focus-visible {
    border-color: rgb(var(--ta-accent) / 0.5);
  }
  .grimoire-new-title {
    font-weight: 600;
  }
  .grimoire-new-text {
    max-width: 14rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
