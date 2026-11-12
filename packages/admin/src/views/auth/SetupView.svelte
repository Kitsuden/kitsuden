<script lang="ts">
  import { t } from "$lib/i18n";
  import { Eye, EyeOff } from "lucide-svelte";

  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import { Alert, Button, Card, CardContent, Input, Label } from "$lib/tallao";
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
  <div class="grid-overlay" aria-hidden="true"></div>

  <div class="auth-panel">
    <Card>
      <CardContent class="auth-panel-body">
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
          <Alert variant="error" class="mb-4">{error}</Alert>
        {/if}

        <form onsubmit={handleSetup} class="auth-form">
          {#if needsSetupToken()}
            <div class="field">
              <Label for="setup-token">{t("setupView.setupToken")}</Label>
              <Input
                bind:value={setupToken}
                type="text"
                id="setup-token"
                autocomplete="off"
                spellcheck="false"
                required
              />
              <p class="field-note">{t("setupView.setupTokenHint")}</p>
            </div>
          {/if}

          <div class="field">
            <Label for="name">{t("setupView.visibleName")}</Label>
            <Input
              bind:value={name}
              type="text"
              id="name"
              placeholder={t("setupView.admin")}
              required
            />
          </div>

          <div class="field">
            <Label for="email">{t("setupView.adminEmail")}</Label>
            <Input
              bind:value={email}
              type="email"
              id="email"
              placeholder={t("setupView.emailPlaceholder")}
              required
            />
          </div>

          <div class="field">
            <Label for="password">{t("setupView.masterPassword")}</Label>
            <div class="password-row">
              <!-- The type changes live; the value stays in the same binding. -->
              <Input
                bind:value={password}
                type={showPassword ? "text" : "password"}
                id="password"
                placeholder={t("setupView.minCharacters", { MIN_PASSWORD })}
                minlength={MIN_PASSWORD}
                autocomplete="new-password"
                required
              />
              <Button
                variant="ghost"
                size="icon"
                onclick={() => (showPassword = !showPassword)}
                ariaLabel={showPassword ? t("setupView.hidePassword") : t("setupView.showPassword")}
                aria-pressed={showPassword}
                title={showPassword ? t("setupView.hidePassword") : t("setupView.showPassword")}
              >
                {#if showPassword}
                  <EyeOff size={17} aria-hidden="true" />
                {:else}
                  <Eye size={17} aria-hidden="true" />
                {/if}
              </Button>
            </div>
            {#if password.length > 0 && !passwordLongEnough}
              <p class="field-note warn">
                {t("setupView.missingCharacters", {
                  passwordCount: MIN_PASSWORD - password.length,
                })}
              </p>
            {/if}
          </div>

          <div class="field">
            <Label for="password-confirm">{t("setupView.repeatsPassword")}</Label>
            <Input
              bind:value={passwordConfirm}
              type={showPassword ? "text" : "password"}
              id="password-confirm"
              placeholder={t("setupView.theSameAgain")}
              aria-invalid={passwordConfirm.length > 0 && !passwordsMatch ? "true" : undefined}
              autocomplete="new-password"
              required
            />
            {#if passwordConfirm.length > 0 && !passwordsMatch}
              <p class="field-note warn">{t("setupView.doNotMatch")}</p>
            {:else if passwordsMatch}
              <p class="field-note ok">{t("setupView.matching")}</p>
            {/if}
          </div>

          <Button type="submit" size="lg" class="w-full" disabled={!canSubmit} {loading}>
            {t("setupView.initializeKitsuden")}
          </Button>
        </form>

        <p class="auth-hint">
          {t("setupView.thisAccountIsTheOnly")}
        </p>
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

  /*
   * The theme's own tokens (their defaults live in `src/style.css`, which is loaded before
   * this screen), so the page and tallao's controls on it agree in light and in dark.
   */
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
    max-width: 420px;
    margin: auto;
  }

  .auth-panel :global(.auth-panel-body) {
    padding: 2rem 1.5rem;
  }

  .brand {
    text-align: center;
    margin-bottom: 1.5rem;
  }

  .brand-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 60px;
    height: 60px;
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

  .password-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .password-row :global(input) {
    flex: 1;
    min-width: 0;
  }

  .field-note {
    font-size: 0.75rem;
    color: rgb(var(--kitsuden-text-dim));
  }

  .field-note.warn {
    color: rgb(var(--kitsuden-danger));
  }

  .field-note.ok {
    color: rgb(var(--kitsuden-green));
  }

  .auth-hint {
    margin-top: 1.5rem;
    text-align: center;
    font-size: 0.75rem;
    line-height: 1.5;
    color: rgb(var(--kitsuden-text-dim));
  }
</style>
