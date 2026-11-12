<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * `KITSUDEN_ADMIN_MFA=required` and this admin has no second factor yet.
   *
   * The API answers 403 (`reason: MFA_REQUIRED`) to everything but better-auth,
   * so the panel would only draw broken screens: it shows the enrolment and
   * nothing else. Once the first code is confirmed, `checkSession` brings the
   * new flag and the layout renders the app.
   */
  import TwoFactorPanel from "$lib/components/settings/TwoFactorPanel.svelte";
  import { signOut } from "$lib/auth.svelte";
  import { Button } from "$lib/tallao";

  async function leave() {
    await signOut();
    window.location.href = "/";
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-kitsuden-bg p-6">
  <div class="w-full max-w-lg space-y-4">
    <p class="text-sm text-kitsuden-text">{t("twoFactor.required")}</p>
    <TwoFactorPanel />
    <Button variant="ghost" size="sm" onclick={leave}>{t("twoFactor.signOut")}</Button>
  </div>
</div>
