<script lang="ts">
  import { getLocale, t } from "$lib/i18n";
  import "../style.css";
  import "../assets/main.css";
  import { onMount } from "svelte";
  import { Toaster } from "svelte-sonner";

  import {
    checkSession,
    isLoggedIn,
    isStaff,
    getChecked,
    isInitialized,
    checkInit,
    loadSocialProviders,
    mustEnrolTwoFactor,
  } from "$lib/auth.svelte";
  import SidebarLayout from "$lib/components/layout/SidebarLayout.svelte";
  import { es, setLabels } from "$lib/tallao";
  import { loadTheme, currentTheme } from "$lib/theme.svelte";
  import LoginView from "$views/auth/LoginView.svelte";
  import SetupView from "$views/auth/SetupView.svelte";
  import TwoFactorRequiredView from "$views/auth/TwoFactorRequiredView.svelte";

  // Svelte 5 children snippet for layout
  const { children } = $props<{ children: () => any }>();

  // tallao's own texts (close buttons, "No results"…) are English by default. Changing the
  // panel's language reloads the page, so choosing them once here is enough.
  if (getLocale() === "es") setLabels(es);

  const checked = $derived(getChecked());
  // A "user" account with a session (sign-up is open) does not see the panel: the API already
  // denies it everything and the shell only showed broken screens.
  const loggedIn = $derived(isLoggedIn() && isStaff());
  const initialized = $derived(isInitialized());
  const mustEnrol = $derived(mustEnrolTwoFactor());
  let loading = $state(true);

  onMount(async () => {
    await loadTheme();
    await checkInit();

    // Only check session if the system is already initialized
    if (isInitialized()) {
      // The sign-in options tell whether admins must have a second factor.
      await Promise.all([checkSession(), loadSocialProviders()]);
    }

    loading = false;
  });
</script>

<!--
  Container for notices. A hundred toast() calls spread across the
  panel rendered nothing because nobody mounted <Toaster />: saving, deleting or
  failing gave no signal.
-->
<Toaster theme={currentTheme() === "latte" ? "light" : "dark"} richColors position="bottom-right" />

{#if loading}
  <div class="min-h-screen flex items-center justify-center bg-kitsuden-bg">
    <div class="flex flex-col items-center gap-4">
      <div
        class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
      ></div>
      <p class="text-kitsuden-subtle text-sm">{t("common.loading")}</p>
    </div>
  </div>
{:else if !initialized}
  <SetupView />
{:else if loggedIn && mustEnrol}
  <TwoFactorRequiredView />
{:else if loggedIn}
  <SidebarLayout>
    {@render children()}
  </SidebarLayout>
{:else if checked}
  <LoginView />
{:else}
  <div class="min-h-screen flex items-center justify-center bg-kitsuden-bg">
    <div class="flex flex-col items-center gap-4">
      <div
        class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
      ></div>
      <p class="text-kitsuden-subtle text-sm">{t("common.loading")}</p>
    </div>
  </div>
{/if}
