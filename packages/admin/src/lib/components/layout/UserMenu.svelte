<!--
  The user menu: who is signed in (name, real role), the language, the theme and sign out.
  The top bar shows it as an avatar; the sidebar's foot as a row with the name (`row`).
-->
<script lang="ts">
  import { ChevronsUpDown } from "lucide-svelte";

  import { signOut, type AuthUser } from "$lib/auth.svelte";
  import { getLocale, setLocale, t } from "$lib/i18n";
  import { LANGUAGES } from "$lib/i18n/locale.svelte";
  import { Avatar, Button, DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from "$lib/tallao";
  import { currentTheme, setTheme, themes } from "$lib/theme.svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  interface Props {
    user: AuthUser;
    /** Avatar + name + role, as wide as its container (the sidebar's foot). */
    row?: boolean;
    /** The sidebar is collapsed: the row shrinks back to the avatar. */
    collapsed?: boolean;
  }
  const { user, row = false, collapsed = false }: Props = $props();

  /** The name, or the local part of the email when there is none. */
  const name = $derived(user.name?.trim() || user.email?.split("@")[0] || "?");

  /** Known roles are translated; an installation's own role is shown as it is. */
  const role = $derived.by(() => {
    switch (user.role) {
      case "admin":
        return t("currentUser.adminRole");
      case "editor":
        return t("currentUser.editorRole");
      case "user":
        return t("currentUser.userRole");
      default:
        return user.role || t("currentUser.userRole");
    }
  });

  /** Only http(s) images or the API's own routes; any other scheme leaves the initial. */
  const avatar = $derived.by(() => {
    const img = user.image?.trim();
    if (!img) return null;
    if (/^https?:\/\//i.test(img)) return img;
    if (img.startsWith("/") && !img.startsWith("//")) return `${API_URL}${img}`;
    return null;
  });

  const LANGUAGE_NAMES: Record<string, string> = { en: "English", es: "Español" };
  const description = $derived(t("currentUser.description", { name, role }));

  async function handleSignOut() {
    // Wait for the close: without `await` the reload ran before the request and the panel
    // was painted again with the session still alive.
    await signOut();
    // `/login` is not a route: the layout shows the form when there is no session.
    window.location.href = "/";
  }
</script>

<DropdownMenu label={t("shell.userMenu")} placement={row ? "top-start" : "bottom-end"}>
  {#snippet trigger(props)}
    <Button
      {...props}
      variant="ghost"
      size={row && !collapsed ? "md" : "icon"}
      class={row && !collapsed ? "kitsuden-user kitsuden-user--row" : "kitsuden-user"}
      ariaLabel={t("shell.userMenuOf", { name: description })}
      data-testid={row ? "sidebar-user" : "current-user"}
    >
      <Avatar {name} src={avatar} size="sm" initials={1} decorative data-testid="user-avatar" />
      {#if row && !collapsed}
        <span class="kitsuden-user-text">
          <span class="kitsuden-user-name" data-testid="user-name">{name}</span>
          <span class="kitsuden-user-role" data-testid="user-role">{role}</span>
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      {/if}
    </Button>
  {/snippet}

  <MenuLabel>{name} · {role}</MenuLabel>
  <MenuSeparator />
  <MenuLabel>{t("shell.language")}</MenuLabel>
  {#each LANGUAGES as language (language)}
    <MenuItem
      checked={getLocale() === language}
      checkType="radio"
      onSelect={() => setLocale(language)}
    >
      {LANGUAGE_NAMES[language] ?? language}
    </MenuItem>
  {/each}
  <MenuSeparator />
  <MenuLabel>{t("shell.theme")}</MenuLabel>
  {#each themes as theme (theme.id)}
    <MenuItem
      checked={currentTheme() === theme.id}
      checkType="radio"
      onSelect={() => setTheme(theme.id)}
    >
      {theme.name}
    </MenuItem>
  {/each}
  <MenuSeparator />
  <MenuItem onSelect={handleSignOut}>{t("sidebarLayout.signOut")}</MenuItem>
</DropdownMenu>

<style>
  /* The trigger is tallao's ghost Button; the row (the sidebar's foot) fills its width. */
  :global(.kitsuden-user) {
    min-width: 0;
    border-radius: 999px;
  }
  :global(.kitsuden-user.kitsuden-user--row) {
    width: 100%;
    justify-content: flex-start;
    padding: 0.375rem 0.5rem;
    text-align: left;
    border-radius: var(--ta-radius);
  }
  .kitsuden-user-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .kitsuden-user-name {
    overflow: hidden;
    font-size: 0.8125rem;
    font-weight: 500;
    color: rgb(var(--ta-text));
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kitsuden-user-role {
    overflow: hidden;
    font-size: 0.75rem;
    font-weight: 400;
    color: rgb(var(--ta-text-dim));
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
