<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * Two-factor sign-in for the signed-in user (better-auth `twoFactor`).
   *
   * Enrol: password → key + backup codes (shown ONCE) → first code confirms it.
   * Enabled: new backup codes, or turn it off; both ask for the password.
   *
   * No QR image: drawing one needs a library the panel does not ship. The key is
   * what every authenticator accepts by hand, and the `otpauth://` link opens
   * the app directly on a phone.
   */
  import { ShieldCheck, ShieldOff } from "lucide-svelte";

  import {
    getUser,
    enableTwoFactor,
    confirmTwoFactor,
    disableTwoFactor,
    regenerateBackupCodes,
  } from "$lib/auth.svelte";

  const user = $derived(getUser());
  const enabled = $derived(user?.twoFactorEnabled === true);

  let password = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let enrolment = $state<{ uri: string; key: string } | null>(null);
  let backupCodes = $state<string[]>([]);

  function keyOf(uri: string): string {
    try {
      return new URL(uri).searchParams.get("secret") ?? "";
    } catch {
      return "";
    }
  }

  async function run(action: () => Promise<void>) {
    busy = true;
    error = null;
    notice = null;
    try {
      await action();
    } catch (err) {
      error = t("twoFactor.failed", { message: (err as Error).message });
    } finally {
      busy = false;
    }
  }

  const start = (e: Event) => {
    e.preventDefault();
    return run(async () => {
      const result = await enableTwoFactor(password);
      enrolment = { uri: result.totpURI, key: keyOf(result.totpURI) };
      backupCodes = result.backupCodes;
    });
  };

  const confirm = (e: Event) => {
    e.preventDefault();
    return run(async () => {
      await confirmTwoFactor(code);
      enrolment = null;
      code = "";
      password = "";
      notice = t("twoFactor.nowEnabled");
    });
  };

  const turnOff = () =>
    run(async () => {
      await disableTwoFactor(password);
      password = "";
      backupCodes = [];
      notice = t("twoFactor.nowDisabled");
    });

  const newCodes = () =>
    run(async () => {
      const result = await regenerateBackupCodes(password);
      backupCodes = result.backupCodes;
      password = "";
      notice = t("twoFactor.regenerated");
    });

  function cancel() {
    enrolment = null;
    backupCodes = [];
    code = "";
  }

  const inputClass =
    "w-full px-3 py-2 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text focus:border-kitsuden-accent outline-hidden";
  const buttonClass =
    "px-4 py-2 text-sm rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/30 hover:bg-kitsuden-accent/20 transition-colors disabled:opacity-50";
  const plainButtonClass =
    "px-4 py-2 text-sm rounded-lg border border-kitsuden-border text-kitsuden-text hover:border-kitsuden-accent/50 transition-colors disabled:opacity-50";
</script>

<div class="card p-6 border border-kitsuden-border space-y-5">
  <div class="flex items-start gap-3">
    {#if enabled}
      <ShieldCheck class="w-5 h-5 text-kitsuden-green shrink-0" />
    {:else}
      <ShieldOff class="w-5 h-5 text-kitsuden-subtle shrink-0" />
    {/if}
    <div>
      <h2 class="text-lg font-bold text-kitsuden-text">
        {t("twoFactor.title")}
        <span class="ml-2 text-xs font-medium text-kitsuden-subtle">
          {enabled ? t("twoFactor.enabled") : t("twoFactor.disabled")}
        </span>
      </h2>
      <p class="text-sm text-kitsuden-subtle mt-1">{t("twoFactor.description")}</p>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-kitsuden-accent-2" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="text-sm text-kitsuden-green" role="status">{notice}</p>
  {/if}

  {#if !enrolment}
    <div>
      <label class="block text-xs text-kitsuden-subtle mb-1" for="tf-password"
        >{t("twoFactor.password")}</label
      >
      <input
        id="tf-password"
        type="password"
        class={inputClass}
        autocomplete="current-password"
        bind:value={password}
      />
      <p class="text-xs text-kitsuden-subtle mt-1">{t("twoFactor.passwordHint")}</p>
    </div>

    {#if enabled}
      <div class="flex flex-wrap gap-2">
        <button type="button" class={plainButtonClass} disabled={busy} onclick={newCodes}>
          {t("twoFactor.regenerate")}
        </button>
        <button type="button" class={plainButtonClass} disabled={busy} onclick={turnOff}>
          {t("twoFactor.disable")}
        </button>
      </div>
    {:else}
      <form onsubmit={start}>
        <button type="submit" class={buttonClass} disabled={busy}>{t("twoFactor.start")}</button>
      </form>
    {/if}
  {:else}
    <div class="space-y-2">
      <p class="text-sm text-kitsuden-text">{t("twoFactor.scanOrType")}</p>
      <p class="text-xs text-kitsuden-subtle">{t("twoFactor.secretKey")}</p>
      <code class="block break-all font-mono text-sm text-kitsuden-text">{enrolment.key}</code>
      <a class="text-sm text-kitsuden-accent underline" href={enrolment.uri}
        >{t("twoFactor.openInApp")}</a
      >
    </div>

    <form class="space-y-2" onsubmit={confirm}>
      <label class="block text-xs text-kitsuden-subtle mb-1" for="tf-code"
        >{t("twoFactor.confirmCode")}</label
      >
      <input
        id="tf-code"
        class={inputClass}
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        placeholder="123456"
        required
        bind:value={code}
      />
      <div class="flex gap-2">
        <button type="submit" class={buttonClass} disabled={busy || code.trim().length < 6}>
          {t("twoFactor.confirm")}
        </button>
        <button type="button" class={plainButtonClass} disabled={busy} onclick={cancel}>
          {t("twoFactor.cancel")}
        </button>
      </div>
    </form>
  {/if}

  {#if backupCodes.length > 0}
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-kitsuden-text">{t("twoFactor.backupCodesTitle")}</h3>
      <p class="text-xs text-kitsuden-subtle">{t("twoFactor.backupCodesHint")}</p>
      <pre class="font-mono text-sm text-kitsuden-text">{backupCodes.join("\n")}</pre>
    </div>
  {/if}
</div>
