<script lang="ts">
  import { t } from "$lib/i18n";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
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
  LoginView.svelte — Admin Panel Login
  Cyberpunk glassmorphism aesthetic, centered card.
-->
<div class="login-bg">
  <div class="language-selector"><LanguageSwitcher /></div>
  <!-- Animated grid background -->
  <div class="grid-overlay"></div>

  <div class="login-card">
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
        >
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      </div>
      <h1 class="brand-name">{t("common.kitsuden")}</h1>
      <p class="brand-sub">{t("loginView.adminConsole")}</p>
    </div>

    <!-- Error -->
    {#if errorVisible}
      <div class="error-banner">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line
            x1="9"
            y1="9"
            x2="15"
            y2="15"
          />
        </svg>
        {errorVisible}
      </div>
    {/if}

    {#if warning}
      <div class="notice-banner" role="status">{warning}</div>
    {/if}

    <!-- Form -->
    {#if mode === "entrar"}
      <form onsubmit={handleLogin} class="login-form">
        <div class="field">
          <label class="field-label" for="email">{t("common.email")}</label>
          <input
            bind:value={email}
            type="email"
            id="email"
            placeholder={t("loginView.emailPlaceholder")}
            class="field-input"
            autocomplete="email"
            required
          />
        </div>
        <div class="field">
          <label class="field-label" for="password">{t("common.password")}</label>
          <input
            bind:value={password}
            type="password"
            id="password"
            placeholder="••••••••"
            class="field-input"
            autocomplete="current-password"
            required
          />
        </div>
        <button type="submit" disabled={loading} class="login-btn">
          {#if loading}
            <span class="spinner"></span>
          {:else}
            <span>{t("loginView.signIn")}</span>
          {/if}
        </button>
      </form>

      {#if pendingVerification}
        <button type="button" class="link-btn" disabled={sending || !email} onclick={handleResend}>
          {t("loginView.resendConfirmationEmail")}
        </button>
      {/if}
      <button type="button" class="link-btn" onclick={() => changeMode("olvido")}>
        {t("loginView.forgotYourPassword")}
      </button>
      {#if magicLinks}
        <button type="button" class="link-btn" onclick={() => changeMode("magic")}>
          {t("loginView.emailMeALink")}
        </button>
      {/if}
    {:else if mode === "code"}
      <form onsubmit={handleCode} class="login-form">
        <p class="field-help">
          {useBackup ? t("loginView.backupCodePrompt") : t("loginView.twoFactorPrompt")}
        </p>
        <div class="field">
          <label class="field-label" for="two-factor-code">
            {useBackup ? t("loginView.backupCode") : t("loginView.code")}
          </label>
          <input
            bind:value={twoFactorCode}
            id="two-factor-code"
            class="field-input"
            autocomplete="one-time-code"
            inputmode={useBackup ? "text" : "numeric"}
            required
          />
        </div>
        <label class="check-row">
          <input type="checkbox" bind:checked={trustDevice} />
          <span>{t("loginView.trustDevice")}</span>
        </label>
        <button type="submit" disabled={sending} class="login-btn">
          {#if sending}
            <span class="spinner"></span>
          {:else}
            <span>{t("loginView.verify")}</span>
          {/if}
        </button>
      </form>
      <button
        type="button"
        class="link-btn"
        onclick={() => {
          useBackup = !useBackup;
          twoFactorCode = "";
          localError = null;
        }}
      >
        {useBackup ? t("loginView.useAuthenticator") : t("loginView.useBackupCode")}
      </button>
      <button type="button" class="link-btn" onclick={() => changeMode("entrar")}>
        {t("loginView.reenter")}
      </button>
    {:else if mode === "magic"}
      <form onsubmit={handleMagic} class="login-form">
        <div class="field">
          <label class="field-label" for="magic-email">{t("common.email")}</label>
          <input
            bind:value={email}
            type="email"
            id="magic-email"
            placeholder={t("loginView.emailPlaceholder")}
            class="field-input"
            autocomplete="email"
            required
          />
        </div>
        <button type="submit" disabled={sending} class="login-btn">
          {#if sending}
            <span class="spinner"></span>
          {:else}
            <span>{t("loginView.sendSignInLink")}</span>
          {/if}
        </button>
      </form>
      <button type="button" class="link-btn" onclick={() => changeMode("entrar")}>
        {t("loginView.reenter")}
      </button>
    {:else if mode === "olvido"}
      <form onsubmit={handleForgot} class="login-form">
        <div class="field">
          <label class="field-label" for="forgot-email">{t("common.email")}</label>
          <input
            bind:value={email}
            type="email"
            id="forgot-email"
            placeholder={t("loginView.emailPlaceholder")}
            class="field-input"
            autocomplete="email"
            required
          />
        </div>
        <button type="submit" disabled={sending} class="login-btn">
          {#if sending}
            <span class="spinner"></span>
          {:else}
            <span>{t("loginView.sendLink")}</span>
          {/if}
        </button>
      </form>
      <button type="button" class="link-btn" onclick={() => changeMode("entrar")}>
        {t("loginView.reenter")}
      </button>
    {:else}
      <form onsubmit={handleNew} class="login-form">
        <div class="field">
          <label class="field-label" for="new-password">{t("loginView.newPassword")}</label>
          <input
            bind:value={newPassword}
            type="password"
            id="new-password"
            class="field-input"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>
        <div class="field">
          <label class="field-label" for="repeat-password">{t("loginView.repitela")}</label>
          <input
            bind:value={repeatPassword}
            type="password"
            id="repeat-password"
            class="field-input"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>
        <button type="submit" disabled={sending} class="login-btn">
          {#if sending}
            <span class="spinner"></span>
          {:else}
            <span>{t("loginView.savePassword")}</span>
          {/if}
        </button>
      </form>
    {/if}

    {#if mode === "entrar" && providers.length > 0}
      <div class="divider"><span>o</span></div>
      <div class="social-list">
        {#each providers as provider (provider.id)}
          <button
            type="button"
            class="social-btn"
            disabled={loading}
            style:--brand={PROVIDER_STYLE[provider.id]?.color ?? "#4a4a5a"}
            onclick={() => handleSocial(provider.id)}
          >
            {#if PROVIDER_STYLE[provider.id]}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d={PROVIDER_STYLE[provider.id].icon} />
              </svg>
            {/if}
            <span>{t("loginView.continueWith")} {provider.label}</span>
          </button>
        {/each}
      </div>
      <!-- Signing in here creates the account if it does not exist, but this console requires
           the admin role: without it, checkSession kicks it out just like a wrong password. -->
      <p class="social-note">{t("loginView.theConsoleStillRequiresRole")}</p>
    {/if}

    <p class="login-hint">{t("loginView.builtWithBetterAuth")}</p>
  </div>
</div>

<style>
  .language-selector {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 10;
  }

  /* ── Background ── */
  .login-bg {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0612;
    overflow: hidden;
  }

  .grid-overlay {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(168, 85, 247, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(168, 85, 247, 0.03) 1px, transparent 1px);
    background-size: 60px 60px;
    animation: drift 20s linear infinite;
  }

  @keyframes drift {
    from {
      transform: translate(0, 0);
    }
    to {
      transform: translate(60px, 60px);
    }
  }

  /* ── Card ── */
  .login-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 380px;
    padding: 2.5rem 2rem;
    background: rgba(16, 16, 24, 0.7);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(168, 85, 247, 0.08);
    border-radius: 1.25rem;
    box-shadow:
      0 0 80px rgba(168, 85, 247, 0.05),
      inset 0 0 60px rgba(0, 0, 0, 0.3);
  }

  /* ── Brand ── */
  .brand {
    text-align: center;
    margin-bottom: 2rem;
  }

  .brand-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: linear-gradient(135deg, rgba(168, 85, 247, 0.12), rgba(168, 85, 247, 0.03));
    border: 1px solid rgba(168, 85, 247, 0.15);
    color: #c084fc;
    margin-bottom: 1rem;
  }

  .brand-name {
    font-size: 1.375rem;
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.02em;
  }

  .brand-sub {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 4px;
  }

  /* ── Error ── */
  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    margin-bottom: 1.25rem;
    border-radius: 10px;
    background: rgba(255, 45, 111, 0.08);
    border: 1px solid rgba(255, 45, 111, 0.15);
    color: #ff6b8a;
    font-size: 0.75rem;
    font-weight: 500;
  }

  /* ── Form ── */
  .login-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.35);
  }

  .field-input {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 0.85rem;
    color: #fff;
    outline: none;
    transition:
      border-color 0.2s,
      box-shadow 0.2s;
    font-family: inherit;
  }

  .field-input::placeholder {
    color: rgba(255, 255, 255, 0.15);
  }

  .field-input:focus {
    border-color: rgba(168, 85, 247, 0.3);
    box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.06);
  }

  /* ── Button ── */
  .login-btn {
    margin-top: 0.5rem;
    width: 100%;
    padding: 12px;
    border-radius: 10px;
    border: none;
    background: linear-gradient(120deg, #a855f7, #ff2d6f);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition:
      transform 0.15s,
      box-shadow 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: inherit;
  }

  .login-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 24px rgba(168, 85, 247, 0.2);
  }

  .login-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .login-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(10, 10, 18, 0.3);
    border-top-color: #0a0612;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ── Social ── */
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 1.5rem 0 1rem;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: rgba(255, 255, 255, 0.2);
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: rgba(255, 255, 255, 0.06);
  }

  .social-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .social-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 11px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.8rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition:
      border-color 0.2s,
      background 0.2s;
  }

  .social-btn:hover:not(:disabled) {
    border-color: var(--brand);
    background: color-mix(in srgb, var(--brand) 12%, transparent);
  }

  .social-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .social-btn svg {
    color: var(--brand);
    flex: none;
  }

  .social-note {
    text-align: center;
    font-size: 0.6rem;
    color: rgba(255, 255, 255, 0.25);
    margin-top: 0.75rem;
  }

  /* ── Hint ── */
  .login-hint {
    text-align: center;
    font-size: 0.6rem;
    color: rgba(255, 255, 255, 0.15);
    margin-top: 1.5rem;
  }

  .notice-banner {
    padding: 10px 14px;
    margin-bottom: 1.25rem;
    border-radius: 10px;
    background: rgba(74, 217, 145, 0.08);
    border: 1px solid rgba(74, 217, 145, 0.18);
    color: #6ee7a8;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .field-help {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
    color: rgba(255, 255, 255, 0.55);
  }

  .link-btn {
    display: block;
    width: 100%;
    margin-top: 0.75rem;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.45);
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
    text-align: center;
  }

  .link-btn:hover:not(:disabled) {
    color: #fff;
    text-decoration: underline;
  }

  .link-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
