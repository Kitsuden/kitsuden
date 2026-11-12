<script lang="ts">
  import { t } from "$lib/i18n";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import { Alert, Button, Card, CardContent, Checkbox, Input, Label } from "$lib/tallao";
  import {
    signIn,
    signOut,
    signInWithProvider,
    loadSocialProviders,
    getSocialProviders,
    checkSession,
    getLoading,
    getError,
    isLoggedIn,
    isStaff,
    requestPasswordReset,
    resetPassword,
    resendVerification,
    requestMagicLink,
    verifyTwoFactor,
    hasMagicLink,
  } from "../../lib/auth.svelte";

  import { goto } from "$app/navigation";

  let email = $state("");
  let password = $state("");
  let localError = $state<string | null>(null);

  const loading = $derived(getLoading());
  const storeError = $derived(getError());
  const error = $derived(localError || storeError);
  const providers = $derived(getSocialProviders());
  const magicLinks = $derived(hasMagicLink());

  /**
   * What the card shows: sign in, request the reset link, or set the
   * new password.
   *
   * All three live HERE and not on their own routes because, without a session, the panel
   * renders this login on any route: a `/reset-password` page would be
   * covered by it. better-auth returns from the link to the root with `?token=`, and it
   * is this component that recognizes it.
   *
   * Before, none of this existed: verification could not be requested
   * again and password recovery had neither a button nor a form, so
   * the emails would have led nowhere.
   */
  let mode = $state<"entrar" | "olvido" | "new" | "magic" | "code">("entrar");
  // Two-factor step: the authenticator code, or a backup code instead.
  let twoFactorCode = $state("");
  let useBackup = $state(false);
  let trustDevice = $state(false);
  let warning = $state<string | null>(null);
  let pendingVerification = $state(false);
  let resetToken = $state<string | null>(null);
  let newPassword = $state("");
  let repeatPassword = $state("");
  let sending = $state(false);

  // Outside "sign in" mode, an old store error has nothing to do
  // with what is being done.
  const errorVisible = $derived(mode === "entrar" ? error : localError);

  // The URL is read once. No reactive state is read in here, so
  // the effect cannot fire again with what it writes.
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const failed = params.get("error");
    // A magic link that failed comes back with `?login=magic-link&error=…`
    // (see requestMagicLink); a reset link only with `?error=`.
    if (params.get("login") === "magic-link") {
      if (failed) {
        localError =
          failed === "failed_to_create_session"
            ? t("loginView.magicLinkRefused")
            : failed === "new_user_signup_disabled"
              ? t("loginView.magicLinkNoSignUp")
              : t("loginView.magicLinkExpired");
        mode = "magic";
      }
      return;
    }
    if (token) {
      resetToken = token;
      mode = "new";
    }
    if (failed === "INVALID_TOKEN") {
      localError = t("loginView.theLinkHasExpiredOr");
      mode = "olvido";
    }
  });

  // The social buttons are dictated by the server: rendering one without credentials
  // configured only fails AFTER the redirect, already outside the site.
  $effect(() => {
    void loadSocialProviders();
  });

  const PROVIDER_STYLE: Record<string, { color: string; icon: string }> = {
    // Discord blurple: it is the brand by which the button is recognized.
    discord: {
      color: "#5865f2",
      icon: "M20.3 4.5A19.8 19.8 0 0 0 15.4 3l-.2.5c1.6.4 2.9 1 4.1 1.8a13.7 13.7 0 0 0-10.6 0A12 12 0 0 1 12.8 3.5L12.6 3a19.8 19.8 0 0 0-4.9 1.5C4.5 9.2 3.7 13.7 4.1 18.2a19.9 19.9 0 0 0 6 3l1.2-2c-.7-.2-1.3-.5-1.9-.9l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.2.7-1.9 1l1.2 1.9a19.9 19.9 0 0 0 6-3c.5-5.2-.8-9.7-3.6-13.7ZM9.7 15.5c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4s2.2 1.1 2.2 2.4c0 1.3-1 2.4-2.2 2.4Zm4.6 0c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4s2.2 1.1 2.2 2.4c0 1.3-1 2.4-2.2 2.4Z",
    },
    github: {
      color: "#24292f",
      icon: "M12 2A10 10 0 0 0 8.8 21.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.7.4-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z",
    },
    google: {
      color: "#ea4335",
      icon: "M12 11v2.9h4.1a3.6 3.6 0 0 1-1.5 2.3l2.4 1.9c1.4-1.3 2.2-3.2 2.2-5.5 0-.5 0-1-.1-1.5H12Zm-6.6 1.9-.5 2.1-2.1.1A9 9 0 0 1 12 3c2.3 0 4.4.9 6 2.3l-2.5 2.5A5.4 5.4 0 0 0 6.9 10a5.4 5.4 0 0 0-1.5 2.9ZM12 21c-3.5 0-6.5-2-8-4.9l3.4-2.7A5.4 5.4 0 0 0 12 17c1 0 2-.3 2.8-.8l2.5 1.9A9 9 0 0 1 12 21Z",
    },
    microsoft: {
      color: "#00a4ef",
      icon: "M3 3h8.5v8.5H3V3Zm9.5 0H21v8.5h-8.5V3ZM3 12.5h8.5V21H3v-8.5Zm9.5 0H21V21h-8.5v-8.5Z",
    },
  };

  async function handleSocial(providerId: string) {
    localError = null;
    try {
      await signInWithProvider(providerId, window.location.origin);
    } catch {
      // the error is already in the store
    }
  }

  async function handleLogin(e: Event) {
    e.preventDefault();
    localError = null;

    try {
      const signInResult = await signIn(email, password);

      // Two-factor sign-in: no session yet; ask for the code.
      if (signInResult?.twoFactorRedirect) {
        password = "";
        twoFactorCode = "";
        useBackup = false;
        mode = "code";
        return;
      }

      // Better-Auth sign-in may not return additionalFields (like role).
      // Fetch the full session to get the complete user object with role.
      await checkSession();

      // Only staff gets in (admin or editor)
      if (!isStaff()) {
        console.warn("[login] User is not staff, signing out. Role:", signInResult?.user?.role);
        localError = t("loginView.accessDeniedAdminRoleRequired");
        await signOut();
        return;
      }

      goto("/");
    } catch (err) {
      console.error("[login] Login error:", err);
      // With mandatory verification, the password can be correct and still
      // not let you in. This is said plainly and a resend is offered, instead of
      // an English "Email not verified" with no way out.
      if ((err as { code?: string })?.code === "EMAIL_NOT_VERIFIED") {
        pendingVerification = true;
        localError = t("loginView.youMustConfirmYourEmail");
      }
    }
  }

  async function handleResend() {
    warning = null;
    sending = true;
    try {
      await resendVerification(email);
      localError = null;
      warning = t("loginView.weSentYouAnotherLink");
    } catch (err) {
      localError = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  async function handleForgot(e: Event) {
    e.preventDefault();
    localError = null;
    warning = null;
    sending = true;
    try {
      await requestPasswordReset(email);
      // The same message whether or not the account exists: distinguishing it would allow
      // finding out which emails are registered by trying addresses.
      warning = t("loginView.ifAccountExistsWith");
    } catch (err) {
      localError = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  async function handleNew(e: Event) {
    e.preventDefault();
    localError = null;
    if (newPassword.length < 8) {
      localError = t("loginView.thePasswordNeedsAtLeast");
      return;
    }
    if (newPassword !== repeatPassword) {
      localError = t("loginView.theTwoPasswordsDoNotMatch");
      return;
    }
    if (!resetToken) {
      localError = t("loginView.missingResetLink");
      mode = "olvido";
      return;
    }
    sending = true;
    try {
      await resetPassword(resetToken, newPassword);
      // Remove the token from the URL: reloading would return to this form with a
      // token that is no longer valid.
      window.history.replaceState({}, "", window.location.pathname);
      resetToken = null;
      newPassword = "";
      repeatPassword = "";
      mode = "entrar";
      warning = t("loginView.passwordChangedEntersWithThe");
    } catch (err) {
      localError = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  /** After any successful sign-in: same staff rule as the password path. */
  async function enterIfStaff() {
    await checkSession();
    if (!isStaff()) {
      localError = t("loginView.accessDeniedAdminRoleRequired");
      await signOut();
      return;
    }
    goto("/");
  }

  async function handleCode(e: Event) {
    e.preventDefault();
    localError = null;
    sending = true;
    try {
      await verifyTwoFactor(twoFactorCode, useBackup ? "backup" : "totp", trustDevice);
      twoFactorCode = "";
      await enterIfStaff();
    } catch {
      localError = t("loginView.invalidCode");
    } finally {
      sending = false;
    }
  }

  async function handleMagic(e: Event) {
    e.preventDefault();
    localError = null;
    warning = null;
    sending = true;
    try {
      await requestMagicLink(email);
      // Same message whether or not the address may sign in.
      warning = t("loginView.ifAccountExistsMagic");
    } catch (err) {
      localError = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  function changeMode(next: "entrar" | "olvido" | "magic") {
    if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
    mode = next;
    localError = null;
    warning = null;
    pendingVerification = false;
  }
</script>

<!--
  LoginView.svelte — the panel's sign-in page: a centred tallao Card on the theme's
  background, so it follows light and dark like the rest of the panel.
-->
<div class="auth-bg">
  <div class="language-selector"><LanguageSwitcher /></div>
  <div class="grid-overlay" aria-hidden="true"></div>

  <div class="auth-panel">
    <Card>
      <CardContent class="auth-panel-body">
        <!-- Logo / Brand -->
        <div class="brand">
          <div class="brand-icon">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h1 class="brand-name">{t("common.kitsuden")}</h1>
          <p class="brand-sub">{t("loginView.adminConsole")}</p>
        </div>

        {#if errorVisible}
          <Alert variant="error" class="mb-4">{errorVisible}</Alert>
        {/if}

        {#if warning}
          <Alert variant="success" class="mb-4">{warning}</Alert>
        {/if}

        <!-- Form -->
        {#if mode === "entrar"}
          <form onsubmit={handleLogin} class="auth-form">
            <div class="field">
              <Label for="email">{t("common.email")}</Label>
              <Input
                bind:value={email}
                type="email"
                id="email"
                placeholder={t("loginView.emailPlaceholder")}
                autocomplete="email"
                required
              />
            </div>
            <div class="field">
              <Label for="password">{t("common.password")}</Label>
              <Input
                bind:value={password}
                type="password"
                id="password"
                placeholder="••••••••"
                autocomplete="current-password"
                required
              />
            </div>
            <Button type="submit" size="lg" class="w-full" {loading}>
              {t("loginView.signIn")}
            </Button>
          </form>

          <div class="auth-links">
            {#if pendingVerification}
              <Button
                variant="ghost"
                size="sm"
                class="w-full"
                disabled={sending || !email}
                onclick={handleResend}
              >
                {t("loginView.resendConfirmationEmail")}
              </Button>
            {/if}
            <Button variant="ghost" size="sm" class="w-full" onclick={() => changeMode("olvido")}>
              {t("loginView.forgotYourPassword")}
            </Button>
            {#if magicLinks}
              <Button variant="ghost" size="sm" class="w-full" onclick={() => changeMode("magic")}>
                {t("loginView.emailMeALink")}
              </Button>
            {/if}
          </div>
        {:else if mode === "code"}
          <form onsubmit={handleCode} class="auth-form">
            <p class="field-help">
              {useBackup ? t("loginView.backupCodePrompt") : t("loginView.twoFactorPrompt")}
            </p>
            <div class="field">
              <Label for="two-factor-code">
                {useBackup ? t("loginView.backupCode") : t("loginView.code")}
              </Label>
              <Input
                bind:value={twoFactorCode}
                id="two-factor-code"
                autocomplete="one-time-code"
                inputmode={useBackup ? "text" : "numeric"}
                required
              />
            </div>
            <Checkbox bind:checked={trustDevice} label={t("loginView.trustDevice")} />
            <Button type="submit" size="lg" class="w-full" loading={sending}>
              {t("loginView.verify")}
            </Button>
          </form>
          <div class="auth-links">
            <Button
              variant="ghost"
              size="sm"
              class="w-full"
              onclick={() => {
                useBackup = !useBackup;
                twoFactorCode = "";
                localError = null;
              }}
            >
              {useBackup ? t("loginView.useAuthenticator") : t("loginView.useBackupCode")}
            </Button>
            <Button variant="ghost" size="sm" class="w-full" onclick={() => changeMode("entrar")}>
              {t("loginView.reenter")}
            </Button>
          </div>
        {:else if mode === "magic"}
          <form onsubmit={handleMagic} class="auth-form">
            <div class="field">
              <Label for="magic-email">{t("common.email")}</Label>
              <Input
                bind:value={email}
                type="email"
                id="magic-email"
                placeholder={t("loginView.emailPlaceholder")}
                autocomplete="email"
                required
              />
            </div>
            <Button type="submit" size="lg" class="w-full" loading={sending}>
              {t("loginView.sendSignInLink")}
            </Button>
          </form>
          <div class="auth-links">
            <Button variant="ghost" size="sm" class="w-full" onclick={() => changeMode("entrar")}>
              {t("loginView.reenter")}
            </Button>
          </div>
        {:else if mode === "olvido"}
          <form onsubmit={handleForgot} class="auth-form">
            <div class="field">
              <Label for="forgot-email">{t("common.email")}</Label>
              <Input
                bind:value={email}
                type="email"
                id="forgot-email"
                placeholder={t("loginView.emailPlaceholder")}
                autocomplete="email"
                required
              />
            </div>
            <Button type="submit" size="lg" class="w-full" loading={sending}>
              {t("loginView.sendLink")}
            </Button>
          </form>
          <div class="auth-links">
            <Button variant="ghost" size="sm" class="w-full" onclick={() => changeMode("entrar")}>
              {t("loginView.reenter")}
            </Button>
          </div>
        {:else}
          <form onsubmit={handleNew} class="auth-form">
            <div class="field">
              <Label for="new-password">{t("loginView.newPassword")}</Label>
              <Input
                bind:value={newPassword}
                type="password"
                id="new-password"
                autocomplete="new-password"
                minlength="8"
                required
              />
            </div>
            <div class="field">
              <Label for="repeat-password">{t("loginView.repitela")}</Label>
              <Input
                bind:value={repeatPassword}
                type="password"
                id="repeat-password"
                autocomplete="new-password"
                minlength="8"
                required
              />
            </div>
            <Button type="submit" size="lg" class="w-full" loading={sending}>
              {t("loginView.savePassword")}
            </Button>
          </form>
        {/if}

        {#if mode === "entrar" && providers.length > 0}
          <div class="divider"><span>o</span></div>
          <div class="social-list">
            {#each providers as provider (provider.id)}
              <Button
                variant="secondary"
                class="w-full"
                disabled={loading}
                onclick={() => handleSocial(provider.id)}
              >
                {#if PROVIDER_STYLE[provider.id]}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                    style:color={PROVIDER_STYLE[provider.id].color}
                    style:flex="none"
                  >
                    <path d={PROVIDER_STYLE[provider.id].icon} />
                  </svg>
                {/if}
                <span>{t("loginView.continueWith")} {provider.label}</span>
              </Button>
            {/each}
          </div>
          <!-- Signing in here creates the account if it does not exist, but this console requires
               the admin role: without it, checkSession kicks it out just like a wrong password. -->
          <p class="auth-note">{t("loginView.theConsoleStillRequiresRole")}</p>
        {/if}

        <p class="auth-hint">{t("loginView.builtWithBetterAuth")}</p>
      </CardContent>
    </Card>
  </div>
</div>

<style>
  .language-selector {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 10;
  }

  /* ── Background: the theme's own, with a faint accent grid ── */
  .auth-bg {
    position: fixed;
    inset: 0;
    display: flex;
    padding: 4rem 1rem 1.5rem;
    overflow-y: auto;
    background: rgb(var(--kitsuden-bg));
  }

  .grid-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(rgb(var(--kitsuden-accent) / 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgb(var(--kitsuden-accent) / 0.05) 1px, transparent 1px);
    background-size: 60px 60px;
  }

  /* `margin: auto` centres the card and still lets a tall form scroll from its top. */
  .auth-panel {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 380px;
    margin: auto;
  }

  .auth-panel :global(.auth-panel-body) {
    padding: 2rem 1.5rem;
  }

  /* ── Brand ── */
  .brand {
    text-align: center;
    margin-bottom: 1.5rem;
  }

  .brand-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    margin-bottom: 0.75rem;
    color: rgb(var(--kitsuden-accent));
    background: rgb(var(--kitsuden-accent) / 0.1);
    border: 1px solid rgb(var(--kitsuden-accent) / 0.2);
    border-radius: 16px;
  }

  .brand-name {
    font-size: 1.375rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: rgb(var(--kitsuden-text));
  }

  .brand-sub {
    margin-top: 4px;
    font-size: 0.8125rem;
    color: rgb(var(--kitsuden-text-dim));
  }

  /* ── Form ── */
  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-help {
    font-size: 0.8125rem;
    color: rgb(var(--kitsuden-text-dim));
  }

  .auth-links {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.75rem;
  }

  /* ── Social ── */
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 1.25rem 0 1rem;
    font-size: 0.75rem;
    color: rgb(var(--kitsuden-text-dim));
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: rgb(var(--kitsuden-border));
  }

  .social-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .auth-note,
  .auth-hint {
    text-align: center;
    font-size: 0.75rem;
    color: rgb(var(--kitsuden-text-dim));
  }

  .auth-note {
    margin-top: 0.75rem;
  }

  .auth-hint {
    margin-top: 1.5rem;
  }
</style>
