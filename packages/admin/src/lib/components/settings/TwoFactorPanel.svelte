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
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Label,
  } from "$lib/tallao";

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
</script>

<Card>
  <CardHeader>
    <div class="flex items-start gap-3">
      {#if enabled}
        <ShieldCheck class="w-5 h-5 text-kitsuden-green shrink-0" aria-hidden="true" />
      {:else}
        <ShieldOff class="w-5 h-5 text-kitsuden-subtle shrink-0" aria-hidden="true" />
      {/if}
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <CardTitle level={2}>{t("twoFactor.title")}</CardTitle>
          <Badge variant={enabled ? "success" : "default"} dot>
            {enabled ? t("twoFactor.enabled") : t("twoFactor.disabled")}
          </Badge>
        </div>
        <p class="text-sm text-kitsuden-subtle mt-1">{t("twoFactor.description")}</p>
      </div>
    </div>
  </CardHeader>
  <CardContent class="space-y-5">
    {#if error}
      <Alert variant="error">{error}</Alert>
    {/if}
    {#if notice}
      <Alert variant="success">{notice}</Alert>
    {/if}

    {#if !enrolment}
      <div class="max-w-md space-y-1.5">
        <Label for="tf-password">{t("twoFactor.password")}</Label>
        <Input
          id="tf-password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
        />
        <p class="text-xs text-kitsuden-subtle">{t("twoFactor.passwordHint")}</p>
      </div>

      {#if enabled}
        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onclick={newCodes}>
            {t("twoFactor.regenerate")}
          </Button>
          <Button variant="danger-ghost" disabled={busy} onclick={turnOff}>
            {t("twoFactor.disable")}
          </Button>
        </div>
      {:else}
        <form onsubmit={start}>
          <Button type="submit" loading={busy}>{t("twoFactor.start")}</Button>
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

      <form class="max-w-md space-y-3" onsubmit={confirm}>
        <div class="space-y-1.5">
          <Label for="tf-code" required>{t("twoFactor.confirmCode")}</Label>
          <Input
            id="tf-code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength={6}
            placeholder="123456"
            required
            bind:value={code}
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} disabled={code.trim().length < 6}>
            {t("twoFactor.confirm")}
          </Button>
          <Button variant="ghost" disabled={busy} onclick={cancel}>
            {t("twoFactor.cancel")}
          </Button>
        </div>
      </form>
    {/if}

    {#if backupCodes.length > 0}
      <div class="space-y-2">
        <h3 class="text-sm font-semibold text-kitsuden-text">{t("twoFactor.backupCodesTitle")}</h3>
        <p class="text-xs text-kitsuden-subtle">{t("twoFactor.backupCodesHint")}</p>
        <pre class="font-mono text-sm text-kitsuden-text overflow-x-auto">{backupCodes.join(
            "\n"
          )}</pre>
      </div>
    {/if}
  </CardContent>
</Card>
