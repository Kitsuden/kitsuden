<script lang="ts">
  /**
   * Who is using the panel, in the top bar.
   *
   * Before, the bar said «Admin» and showed a fixed «A», also for an
   * editor: the panel claimed a role that person did not have. Now it shows the real
   * name, their translated role and their avatar (or their initial if they have none, or if
   * the image does not load: tallao's Avatar falls back to it by itself).
   */
  import { t } from "$lib/i18n";
  import type { AuthUser } from "$lib/auth.svelte";
  import { Avatar } from "$lib/tallao";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  const { user }: { user: AuthUser } = $props();

  /** Visible name: the name, or the local part of the email if there is no name. */
  const name = $derived(user.name?.trim() || user.email?.split("@")[0] || "?");

  /**
   * Readable role. Known ones are translated; an unknown one (an
   * installation's own role) is shown as is rather than inventing a name for it.
   */
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

  /**
   * Only http(s) images or the API's own routes. Any other scheme
   * (`javascript:`, `data:`…) is ignored and the initial remains.
   */
  const avatar = $derived.by(() => {
    const img = user.image?.trim();
    if (!img) return null;
    if (/^https?:\/\//i.test(img)) return img;
    if (img.startsWith("/") && !img.startsWith("//")) return `${API_URL}${img}`;
    return null;
  });
</script>

<div class="flex items-center gap-2 min-w-0" data-testid="current-user">
  <div class="hidden sm:flex flex-col items-end min-w-0 leading-tight">
    <span
      class="text-xs font-medium text-kitsuden-text truncate max-w-[10rem]"
      data-testid="user-name"
    >
      {name}
    </span>
    <span class="text-[10px] text-kitsuden-subtle truncate max-w-[10rem]" data-testid="user-role"
      >{role}</span
    >
  </div>
  <Avatar
    {name}
    src={avatar}
    initials={1}
    aria-label={t("currentUser.description", { name, role })}
    title={t("currentUser.description", { name, role })}
    data-testid="user-avatar"
  />
</div>
