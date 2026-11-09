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

<div class="flex h-full">
  <!-- Sidebar -->
  <aside class="w-60 border-r border-zinc-800 bg-zinc-900/50">
    <div class="p-4">
      <h2 class="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
        {t("agentsLayout.aiControlCenter")}
      </h2>
    </div>

    <nav class="px-2 space-y-1">
      {#each navItems as item}
        <a
          href={item.href}
          class={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
            $page.url.pathname === item.href
              ? "bg-indigo-500/10 text-indigo-400"
              : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50"
          )}
        >
          <svelte:component this={item.icon} size={18} />
          {item.label}
        </a>
      {/each}
    </nav>
  </aside>

  <!-- Main content -->
  <main class="flex-1 overflow-auto">
    <slot />
  </main>
</div>
