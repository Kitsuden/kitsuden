<script lang="ts">
  import { t } from "$lib/i18n";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import { checkInit, checkSession, needsSetupToken } from "../../lib/auth.svelte";

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let passwordConfirm = $state("");
  let setupToken = $state("");
  let showPassword = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  /** Minimum required by the backend. Repeated here to warn before sending. */
  const MIN_PASSWORD = 8;

  /**
   * This password opens the whole installation, and there is not yet any
   * "I forgot my password": there is no other user who can reset it
   * nor an email configured to send it. A typo leaves the
   * installation inaccessible and forces recreating the database.
   *
   * Hence the two protections: repeating it, and being able to see it before sending.
   */
  const passwordLongEnough = $derived(password.length >= MIN_PASSWORD);
  const passwordsMatch = $derived(password.length > 0 && password === passwordConfirm);
  const canSubmit = $derived(
    !loading &&
      name.trim().length > 0 &&
      email.trim().length > 0 &&
      passwordLongEnough &&
      passwordsMatch &&
      (!needsSetupToken() || setupToken.trim().length > 0)
  );

  async function handleSetup(e: Event) {
    e.preventDefault();

    // Disabling the button is not enough: the form is also submitted with Enter.
    if (!passwordLongEnough) {
      error = t("setupView.theMasterPasswordNeedsAt", { MIN_PASSWORD });
      return;
    }
    if (!passwordsMatch) {
      error = t("setupView.theTwoPasswordsDoNotMatch");
      return;
    }

    loading = true;
    error = null;

    try {
      const res = await fetch(`${API_URL}/api/system/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Needed to store the session cookie the backend returns.
        credentials: "include",
        body: JSON.stringify({
          name,
          email,
          password,
          ...(needsSetupToken() ? { setupToken: setupToken.trim() } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || t("setupView.couldNotInitializeThe"));
      }

      // The setup endpoint creates the user but does not open a session, so it is
      // signed in explicitly to obtain the cookie.
      const { signIn } = await import("../../lib/auth.svelte");
      await signIn(email, password);

      await checkInit();
      await checkSession();
    } catch (err: any) {
      error = err.message || t("setupView.anUnexpectedErrorOccurred");
    } finally {
      loading = false;
    }
  }
</script>

<div class="auth-bg">
  <div class="language-selector"><LanguageSwitcher /></div>
  <div class="grid-overlay"></div>
  <div class="glow glow-violet"></div>
  <div class="glow glow-crimson"></div>

  <div class="auth-card">
    <div class="brand">
      <div class="brand-icon">
        <!--
          Kitsune: geometric fox mask. Ears and muzzle use straight
          strokes to rhyme with the background grid.
        -->
        <svg
          width="34"
          height="34"
          viewBox="0 0 32 32"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 5 L10 11 M28 5 L22 11" />
          <path d="M4 5 L6 13 M28 5 L26 13" />
          <path d="M6 13 C6 22, 11 27, 16 29 C21 27, 26 22, 26 13 L22 11 L16 14 L10 11 Z" />
          <path d="M11.5 18 L13.5 18 M18.5 18 L20.5 18" />
          <path d="M16 22 L14.5 24 M16 22 L17.5 24" />
        </svg>
      </div>
      <h1 class="brand-name">{t("common.kitsuden")}</h1>
      <p class="brand-sub">{t("setupView.createMasterAdmin")}</p>
    </div>

    {#if error}
      <div class="error-banner" role="alert">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        {error}
      </div>
    {/if}

    <form onsubmit={handleSetup} class="auth-form">
      {#if needsSetupToken()}
        <div class="field">
          <label class="field-label" for="setup-token">{t("setupView.setupToken")}</label>
          <input
            bind:value={setupToken}
            type="text"
            id="setup-token"
            class="field-input"
            autocomplete="off"
            spellcheck="false"
            required
          />
          <p class="field-note">{t("setupView.setupTokenHint")}</p>
        </div>
      {/if}

      <div class="field">
        <label class="field-label" for="name">{t("setupView.visibleName")}</label>
        <input
          bind:value={name}
          type="text"
          id="name"
          placeholder={t("setupView.admin")}
          class="field-input"
          required
        />
      </div>

      <div class="field">
        <label class="field-label" for="email">{t("setupView.adminEmail")}</label>
        <input
          bind:value={email}
          type="email"
          id="email"
          placeholder={t("setupView.emailPlaceholder")}
          class="field-input"
          required
        />
      </div>

      <div class="field">
        <label class="field-label" for="password">{t("setupView.masterPassword")}</label>
        <div class="input-wrap">
          <!-- The type changes live; the value stays in the same binding. -->
          <input
            bind:value={password}
            type={showPassword ? "text" : "password"}
            id="password"
            placeholder={t("setupView.minCharacters", { MIN_PASSWORD })}
            class="field-input has-affix"
            minlength={MIN_PASSWORD}
            autocomplete="new-password"
            required
          />
          <button
            type="button"
            class="affix-btn"
            onclick={() => (showPassword = !showPassword)}
            aria-label={showPassword ? t("setupView.hidePassword") : t("setupView.showPassword")}
            aria-pressed={showPassword}
            title={showPassword ? t("setupView.hidePassword") : t("setupView.showPassword")}
          >
            {#if showPassword}
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path
                  d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"
                />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            {:else}
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            {/if}
          </button>
        </div>
        {#if password.length > 0 && !passwordLongEnough}
          <p class="field-note warn">
            {t("setupView.missingCharacters", { passwordCount: MIN_PASSWORD - password.length })}
          </p>
        {/if}
      </div>

      <div class="field">
        <label class="field-label" for="password-confirm">{t("setupView.repeatsPassword")}</label>
        <input
          bind:value={passwordConfirm}
          type={showPassword ? "text" : "password"}
          id="password-confirm"
          placeholder={t("setupView.theSameAgain")}
          class="field-input"
          class:mismatch={passwordConfirm.length > 0 && !passwordsMatch}
          autocomplete="new-password"
          required
        />
        {#if passwordConfirm.length > 0 && !passwordsMatch}
          <p class="field-note warn">{t("setupView.doNotMatch")}</p>
        {:else if passwordsMatch}
          <p class="field-note ok">{t("setupView.matching")}</p>
        {/if}
      </div>

      <button type="submit" disabled={!canSubmit} class="auth-btn">
        {#if loading}
          <span class="spinner"></span>
        {:else}
          <span>{t("setupView.initializeKitsuden")}</span>
        {/if}
      </button>
    </form>

    <p class="auth-hint">
      {t("setupView.thisAccountIsTheOnly")}
    </p>
  </div>
</div>

<style>
  .language-selector {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 10;
  }

  /**
   * Palette: violet and crimson over bluish black.
   *
   * They go as local variables and not scattered through the file so that changing the
   * accent is one line.
   *
   * The values match the global tokens in `src/style.css`
   * (--kitsuden-accent / --kitsuden-accent-2, which today are violet and crimson despite the
   * name). They are repeated here instead of used because this screen is seen BEFORE
   * the theme engine loads the site configuration: if it took the
   * tokens, the first frame would come out without color.
   */
  .auth-bg {
    --violeta: #a855f7;
    --violeta-claro: #c084fc;
    --carmesi: #ff2d6f;
    --fondo: #0a0612;
    --texto-tenue: rgba(255, 255, 255, 0.35);

    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--fondo);
    overflow: hidden;
  }

  .grid-overlay {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(168, 85, 247, 0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(168, 85, 247, 0.045) 1px, transparent 1px);
    background-size: 60px 60px;
    animation: drift 20s linear infinite;
  }

  /* Two color spotlights: they give the violet/red blend of the background. */
  .glow {
    position: absolute;
    width: 46vw;
    height: 46vw;
    border-radius: 50%;
    filter: blur(120px);
    opacity: 0.5;
    pointer-events: none;
  }

  .glow-violet {
    background: radial-gradient(circle, rgba(168, 85, 247, 0.5), transparent 70%);
    top: -14vw;
    left: -10vw;
  }

  .glow-crimson {
    background: radial-gradient(circle, rgba(255, 45, 111, 0.34), transparent 70%);
    bottom: -16vw;
    right: -10vw;
  }

  @keyframes drift {
    from {
      transform: translate(0, 0);
    }
    to {
      transform: translate(60px, 60px);
    }
  }

  .auth-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 410px;
    padding: 2.5rem 2rem;
    background: rgba(18, 12, 28, 0.72);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(168, 85, 247, 0.16);
    border-radius: 1.25rem;
    box-shadow:
      0 0 90px rgba(168, 85, 247, 0.12),
      0 0 40px rgba(255, 45, 111, 0.06),
      inset 0 0 60px rgba(0, 0, 0, 0.35);
  }

  .brand {
    text-align: center;
    margin-bottom: 2rem;
  }

  .brand-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 58px;
    height: 58px;
    border-radius: 16px;
    background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(255, 45, 111, 0.08));
    border: 1px solid rgba(168, 85, 247, 0.28);
    color: var(--violeta-claro);
    margin-bottom: 1rem;
  }

  .brand-name {
    font-size: 1.5rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    background: linear-gradient(100deg, var(--violeta-claro), var(--carmesi));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .brand-sub {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--texto-tenue);
    margin-top: 4px;
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    margin-bottom: 1.25rem;
    border-radius: 10px;
    background: rgba(255, 45, 111, 0.1);
    border: 1px solid rgba(255, 45, 111, 0.25);
    color: #ff7ba3;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
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
    color: var(--texto-tenue);
  }

  .input-wrap {
    position: relative;
    display: flex;
  }

  .field-input {
    width: 100%;
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid rgba(168, 85, 247, 0.12);
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

  /* Leaves room for the eye button so it does not cover what was typed. */
  .field-input.has-affix {
    padding-right: 44px;
  }

  .field-input::placeholder {
    color: rgba(255, 255, 255, 0.18);
  }

  .field-input:focus {
    border-color: rgba(168, 85, 247, 0.55);
    box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.12);
  }

  .field-input.mismatch {
    border-color: rgba(255, 45, 111, 0.5);
  }

  .affix-btn {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    transition:
      color 0.15s,
      background 0.15s;
  }

  .affix-btn:hover {
    color: var(--violeta-claro);
    background: rgba(168, 85, 247, 0.1);
  }

  .affix-btn:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.6);
    outline-offset: 1px;
  }

  .field-note {
    font-size: 0.68rem;
    margin: 0;
  }

  .field-note.warn {
    color: #ff7ba3;
  }

  .field-note.ok {
    color: #9fe8a0;
  }

  .auth-btn {
    width: 100%;
    margin-top: 0.35rem;
    padding: 12px;
    border-radius: 10px;
    border: none;
    background: linear-gradient(120deg, var(--violeta), var(--carmesi));
    color: #fff;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition:
      transform 0.15s,
      box-shadow 0.2s,
      filter 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: inherit;
  }

  .auth-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 6px 28px rgba(168, 85, 247, 0.32);
    filter: brightness(1.06);
  }

  .auth-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .auth-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .auth-hint {
    text-align: center;
    font-size: 0.66rem;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 1.5rem;
  }

  /* Anyone who asked for less motion should not see the grid drift. */
  @media (prefers-reduced-motion: reduce) {
    .grid-overlay {
      animation: none;
    }
  }
</style>
