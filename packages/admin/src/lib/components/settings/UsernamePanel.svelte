<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * The signed-in user's username (better-auth `username` plugin, migration 0096).
   *
   * With one set, the login takes "admin" + password as well as the email. It is
   * stored lower-case; 3–30 characters of a–z 0–9 _ . (no `@`, so it never
   * reads like an email). Who may set one: `KITSUDEN_USERNAMES` on the API.
   */
  import { AtSign } from "lucide-svelte";

  import {
    Alert,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Label,
  } from "$lib/tallao";

  import { getUser, setUsername } from "$lib/auth.svelte";

  const user = $derived(getUser());
  const current = $derived(user?.username ?? "");

  let draft = $state<string | null>(null);
  const value = $derived(draft ?? current);
  const normalized = $derived(value.trim().toLowerCase());
  const valid = $derived(/^[a-z0-9_.]{3,30}$/.test(normalized));
  const changed = $derived(normalized !== current);

  let busy = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  function messageOf(err: unknown): string {
    const code = (err as { code?: string })?.code;
    if (code === "USERNAME_IS_ALREADY_TAKEN") return t("username.taken");
    if (code === "USERNAME_STAFF_ONLY") return t("username.staffOnly");
    return (err as Error).message;
  }

  async function run(next: string | null, done: string) {
    busy = true;
    error = null;
    notice = null;
    try {
      await setUsername(next);
      draft = null;
      notice = done;
    } catch (err) {
      error = messageOf(err);
    } finally {
      busy = false;
    }
  }

  const save = (e: Event) => {
    e.preventDefault();
    if (!valid || !changed) return;
    return run(normalized, t("username.saved"));
  };

  const remove = () => run(null, t("username.removed"));
</script>

<Card>
  <CardHeader>
    <div class="flex items-start gap-3">
      <AtSign class="w-5 h-5 text-kitsuden-subtle shrink-0" aria-hidden="true" />
      <div class="min-w-0">
        <CardTitle level={2}>{t("username.title")}</CardTitle>
        <p class="text-sm text-kitsuden-subtle mt-1">{t("username.description")}</p>
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

    <form class="max-w-md space-y-3" onsubmit={save}>
      <div class="space-y-1.5">
        <Label for="account-username">{t("username.label")}</Label>
        <Input
          id="account-username"
          autocomplete="username"
          autocapitalize="none"
          spellcheck={false}
          maxlength={30}
          placeholder="admin"
          {value}
          oninput={(e: Event & { currentTarget: HTMLInputElement }) =>
            (draft = e.currentTarget.value)}
        />
        <p class="text-xs text-kitsuden-subtle">{t("username.rules")}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={!valid || !changed}>
          {t("username.save")}
        </Button>
        {#if current}
          <Button variant="danger-ghost" disabled={busy} onclick={remove}>
            {t("username.remove")}
          </Button>
        {/if}
      </div>
    </form>
  </CardContent>
</Card>
