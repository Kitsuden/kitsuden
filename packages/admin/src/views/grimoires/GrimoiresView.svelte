<script lang="ts">
  import { toast } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import { Castle, Check, Plus } from "lucide-svelte";
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

<div class="space-y-6">
  <!-- Loading State -->
  {#if loading}
    <div class="card p-12 text-center">
      <div
        class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin mx-auto mb-4"
      ></div>
      <p class="text-kitsuden-subtle">{t("grimoiresView.loadingGrimoires")}</p>
    </div>
  {:else}
    <!-- Grimoires Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
      {#each grimoires as grimoire}
        {@const kons = allKons(grimoire)}
        <div
          class="card p-5 relative group"
          class:border-kitsuden-accent={activeGrimoire === grimoire.id}
        >
          {#if activeGrimoire === grimoire.id}
            <div class="absolute top-3 right-3">
              <span
                class="px-2 py-1 text-xs font-medium bg-kitsuden-accent/10 text-kitsuden-accent rounded-full flex items-center gap-1"
              >
                <Check class="w-3 h-3" />
                {t("common.active")}
              </span>
            </div>
          {/if}

          <div class="flex items-start gap-4 mb-4">
            <div
              class="w-12 h-12 rounded-xl bg-linear-to-br from-kitsuden-purple/20 to-kitsuden-accent/20 flex items-center justify-center text-2xl shrink-0"
            >
              <Castle class="w-6 h-6 text-kitsuden-purple" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="font-semibold text-kitsuden-text text-lg">{grimoire.name}</h3>
              <p class="text-xs text-kitsuden-subtle mt-0.5">
                {t("grimoiresView.konsIncluded", { konsCount: kons.length })}
              </p>
            </div>
          </div>

          <p class="text-sm text-kitsuden-text-dim mb-4 line-clamp-2">
            {grimoire.description || t("grimoiresView.noDescriptionAvailable")}
          </p>

          <!-- Included Kons -->
          <div class="mb-4">
            <p class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle mb-2">
              {t("grimoiresView.includedKons")}
            </p>
            <div class="flex flex-wrap gap-1.5">
              {#each kons.slice(0, 6) as kon}
                <span
                  class="px-2 py-1 text-xs bg-kitsuden-surface rounded-md text-kitsuden-text-dim flex items-center gap-1"
                >
                  <span>{getKonIcon(kon)}</span>
                  {getKonName(kon)}
                </span>
              {/each}
              {#if kons.length > 6}
                <span class="px-2 py-1 text-xs bg-kitsuden-surface rounded-md text-kitsuden-subtle">
                  {t("common.more", { v: kons.length - 6 })}
                </span>
              {/if}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2 pt-3 border-t border-kitsuden-border">
            {#if activeGrimoire === grimoire.id}
              <button
                class="btn-secondary flex-1 text-kitsuden-accent-2 border-kitsuden-accent-2/20 hover:bg-kitsuden-accent-2/10"
                onclick={() => deactivateGrimoire()}
              >
                {t("grimoiresView.deactivate")}
              </button>
            {:else}
              <button class="btn-primary flex-1" onclick={() => activateGrimoire(grimoire.id)}>
                {t("common.activate")}
              </button>
            {/if}
            <!-- There was a "view details" button with no action: there is no detail screen. -->
          </div>
        </div>
      {/each}

      <!--
        Create Custom Grimoire Card. It did nothing when clicked; putting together a
        custom ecosystem IS activating kons one by one, so it leads to Kons.
      -->
      <a
        href="/kons"
        class="card p-5 border-dashed border-2 border-kitsuden-border hover:border-kitsuden-accent/50 transition-colors flex flex-col items-center justify-center min-h-[280px] gap-3"
      >
        <div class="w-12 h-12 rounded-xl bg-kitsuden-surface flex items-center justify-center">
          <Plus class="w-6 h-6 text-kitsuden-accent" />
        </div>
        <div class="text-center">
          <h3 class="font-semibold text-kitsuden-text">
            {t("grimoiresView.createCustomGrimoire")}
          </h3>
          <p class="text-xs text-kitsuden-subtle mt-0.5 max-w-[200px]">
            {t("grimoiresView.buildYourOwnEcosystemBy")}
          </p>
        </div>
      </a>
    </div>
  {/if}
</div>

<style>
  @reference "../../style.css";

  .card {
    @apply rounded-xl border border-kitsuden-border bg-kitsuden-card;
  }

  .animate-fade-in {
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
