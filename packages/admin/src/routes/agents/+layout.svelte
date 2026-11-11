<script lang="ts">
  import { t } from "$lib/i18n";
  import { Bot, Activity } from "lucide-svelte";

  import { cn } from "$lib/utils";

  import { page } from "$app/stores";

  const navItems = [
    { href: "/agents", label: t("agentsLayout.agents"), icon: Bot },
    { href: "/agents/traces", label: t("common.traces"), icon: Activity },
    // "Identities" linked to /agents/identities, a route that does not exist (404).
  ];
</script>

<div class="flex h-full flex-col md:flex-row">
  <!-- Section navigation -->
  <aside
    class="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-kitsuden-border bg-kitsuden-card/50"
  >
    <div class="p-4 hidden md:block">
      <p class="text-sm font-semibold text-kitsuden-text-dim uppercase tracking-wider">
        {t("agentsLayout.aiControlCenter")}
      </p>
    </div>

    <nav
      class="flex gap-1 p-2 md:block md:space-y-1 md:pt-0"
      aria-label={t("agentsLayout.aiControlCenter")}
    >
      {#each navItems as item}
        <a
          href={item.href}
          aria-current={$page.url.pathname === item.href ? "page" : undefined}
          class={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
            $page.url.pathname === item.href
              ? "bg-kitsuden-accent/10 text-kitsuden-accent"
              : "text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-border/50"
          )}
        >
          <svelte:component this={item.icon} size={18} />
          {item.label}
        </a>
      {/each}
    </nav>
  </aside>

  <!-- The section's content. Not a <main>: the shell already has the page's only one. -->
  <div class="flex-1 min-w-0 overflow-auto">
    <slot />
  </div>
</div>
