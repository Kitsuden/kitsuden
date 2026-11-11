<script lang="ts">
  import { getLocale, t } from "$lib/i18n";
  import "../style.css";
  import "../assets/main.css";
  import { onMount } from "svelte";

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
  import ConfirmHost from "$lib/components/feedback/ConfirmHost.svelte";
  import AppFrame from "$lib/components/layout/AppFrame.svelte";
  import ShellSkeleton from "$lib/components/layout/ShellSkeleton.svelte";
  import { es, setLabels, Toaster } from "$lib/tallao";
  import { loadTheme } from "$lib/theme.svelte";
  import LoginView from "$views/auth/LoginView.svelte";
  import SetupView from "$views/auth/SetupView.svelte";
  import TwoFactorRequiredView from "$views/auth/TwoFactorRequiredView.svelte";

  // Svelte 5 children snippet for layout
  const { children }: { children: () => any } = $props();

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

  /**
   * Boot: the three questions (is the system set up, who is signed in, which theme and
   * sign-in options) leave together, and the frame is drawn with skeletons meanwhile. They
   * used to run one after another behind a full-screen spinner.
   */
  onMount(async () => {
    await Promise.all([loadTheme(), checkInit(), checkSession(), loadSocialProviders()]);
    loading = false;
  });
</script>

<svelte:head>
  <title>Kitsuden</title>
</svelte:head>

<!-- The one confirmation dialog every screen asks through ($lib/confirm.svelte.ts). -->
<ConfirmHost />

<!-- The one place notices appear: every screen calls tallao's `toast()`. -->
<Toaster position="top-center" label={t("shell.notifications")} />

{#if loading || (!checked && initialized)}
  <ShellSkeleton />
{:else if !initialized}
  <SetupView />
{:else if loggedIn && mustEnrol}
  <TwoFactorRequiredView />
{:else if loggedIn}
  <AppFrame>
    {@render children()}
  </AppFrame>
{:else}
  <LoginView />
{/if}
