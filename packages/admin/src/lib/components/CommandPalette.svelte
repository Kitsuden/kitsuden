<script lang="ts">
  import { t } from "$lib/i18n";
  import {
    Search,
    FilePlus,
    FolderPlus,
    Image,
    Database,
    FileText,
    Blocks,
    Gamepad2,
    GraduationCap,
    Settings,
    LayoutDashboard,
    Brain,
  } from "lucide-svelte";
  import { fade, scale } from "svelte/transition";

  import { cn } from "$lib/utils";

  import { goto } from "$app/navigation";

  interface NavItem {
    path: string;
    label: string;
    icon: any;
  }

  type CommandType = "nav" | "action" | "recent";

  interface CommandItem {
    id: string;
    type: CommandType;
    label: string;
    shortcut?: string;
    icon: any;
    action: () => void;
  }

  const {
    navItems = [],
    bottomNavItems = [],
  }: {
    navItems?: NavItem[];
    bottomNavItems?: NavItem[];
  } = $props();

  let open = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);
  // $state: it is read inside the $effect that gives focus on open. Without
  // reactivity, that effect does not re-run when the reference is assigned and the
  // focus was lost on the first open.
  let inputRef = $state<HTMLInputElement | null>(null);

  // Mock recent datasets / entries
  const recentItems: CommandItem[] = [
    {
      id: "recent-1",
      type: "recent",
      label: t("commandPalette.usersDataset"),
      icon: Database,
      action: () => goto("/datasets"),
    },
    {
      id: "recent-2",
      type: "recent",
      label: t("commandPalette.blogPostsDataset"),
      icon: FileText,
      action: () => goto("/g/kon-blog"),
    },
    {
      id: "recent-3",
      type: "recent",
      label: t("commandPalette.mediaAssets"),
      icon: Image,
      action: () => goto("/g/kon-media"),
    },
    {
      id: "recent-4",
      type: "recent",
      label: t("commandPalette.pageBuilderBlocks"),
      icon: Blocks,
      action: () => goto("/g/kon-blocks"),
    },
    {
      id: "recent-5",
      type: "recent",
      label: t("commandPalette.academyCourses"),
      icon: GraduationCap,
      action: () => goto("/academy"),
    },
    {
      id: "recent-6",
      type: "recent",
      label: t("commandPalette.gamesRegistry"),
      icon: Gamepad2,
      action: () => goto("/g/kon-games"),
    },
  ];

  // Quick actions
  const actionItems: CommandItem[] = [
    {
      id: "action-1",
      type: "action",
      label: t("common.newPost"),
      shortcut: "N",
      icon: FilePlus,
      action: () => goto("/g/kon-blog"),
    },
    {
      id: "action-2",
      type: "action",
      label: t("commandPalette.newDataset"),
      shortcut: "D",
      icon: FolderPlus,
      action: () => goto("/datasets/new"),
    },
    {
      id: "action-3",
      type: "action",
      label: t("commandPalette.goToMedia"),
      shortcut: "M",
      icon: Image,
      action: () => goto("/g/kon-media"),
    },
    {
      id: "action-4",
      type: "action",
      label: t("commandPalette.goToDashboard"),
      shortcut: "H",
      icon: LayoutDashboard,
      action: () => goto("/"),
    },
    {
      id: "action-5",
      type: "action",
      label: t("commandPalette.goToSettings"),
      shortcut: ",",
      icon: Settings,
      action: () => goto("/settings"),
    },
    {
      id: "action-brain",
      type: "action",
      label: t("commandPalette.openKitsudenBrain"),
      icon: Brain,
      action: () => goto("/brain"),
    },
  ];

  // Build full command list from props + static items
  const allItems = $derived<CommandItem[]>([
    ...actionItems,
    ...recentItems,
    ...navItems.map((item) => ({
      id: `nav-${item.path}`,
      type: "nav" as CommandType,
      label: item.label,
      icon: item.icon,
      action: () => goto(item.path),
    })),
    ...bottomNavItems.map((item) => ({
      id: `nav-bottom-${item.path}`,
      type: "nav" as CommandType,
      label: item.label,
      icon: item.icon,
      action: () => goto(item.path),
    })),
  ]);

  const filteredItems = $derived<CommandItem[]>(
    query.trim() === ""
      ? allItems
      : allItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
  );

  // Reset selection when query changes
  $effect(() => {
    query;
    selectedIndex = 0;
  });

  // Focus input when opened
  $effect(() => {
    if (open && inputRef) {
      // The element may be unmounted before the timeout fires.
      setTimeout(() => inputRef?.focus(), 10);
    }
  });

  function handleWindowKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      open = !open;
      if (!open) {
        query = "";
      }
      return;
    }

    if (!open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(filteredItems.length, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex =
        (selectedIndex - 1 + Math.max(filteredItems.length, 1)) % Math.max(filteredItems.length, 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        executeItem(filteredItems[selectedIndex]);
      }
    }
  }

  function closePalette() {
    open = false;
    query = "";
    selectedIndex = 0;
  }

  function executeItem(item: CommandItem) {
    item.action();
    closePalette();
  }

  function handleBackdropClick() {
    closePalette();
  }

  function typeLabel(type: CommandType): string {
    switch (type) {
      case "nav":
        return "Page";
      case "action":
        return "Action";
      case "recent":
        return "Recent";
      default:
        return "";
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[18vh] bg-black/60 backdrop-blur-xs"
    transition:fade={{ duration: 150 }}
    onclick={handleBackdropClick}
  >
    <!-- Palette -->
    <div
      class="w-full max-w-xl overflow-hidden rounded-xl border border-kitsuden-border bg-kitsuden-card shadow-2xl"
      transition:scale={{ duration: 150, start: 0.95 }}
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={t("commandPalette.commandPalette")}
    >
      <!-- Search Input -->
      <div class="flex items-center gap-3 border-b border-kitsuden-border px-4 py-3">
        <Search class="h-5 w-5 shrink-0 text-kitsuden-text-dim" />
        <input
          bind:this={inputRef}
          bind:value={query}
          type="text"
          placeholder={t("commandPalette.searchCommandsPagesAndRecent")}
          class="flex-1 bg-transparent text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden"
        />
        <kbd
          class="hidden items-center gap-1 rounded-sm border border-kitsuden-border bg-kitsuden-bg px-2 py-1 font-mono text-[10px] text-kitsuden-text-dim sm:inline-flex"
        >
          ESC
        </kbd>
      </div>

      <!-- Results -->
      <div class="max-h-[50vh] overflow-y-auto py-1">
        {#if filteredItems.length === 0}
          <div class="px-4 py-8 text-center text-sm text-kitsuden-text-dim">
            {t("commandPalette.noResultsFoundFor", { query })}
          </div>
        {:else}
          {#each filteredItems as item, i (item.id)}
            {@const Icon = item.icon}
            <button
              class={cn(
                "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
                i === selectedIndex
                  ? "bg-kitsuden-accent/10 text-kitsuden-text"
                  : "text-kitsuden-text-dim hover:bg-kitsuden-border/30 hover:text-kitsuden-text"
              )}
              onclick={() => executeItem(item)}
              onmouseenter={() => (selectedIndex = i)}
              type="button"
            >
              <Icon class="h-4 w-4 shrink-0" />
              <span class="flex-1 truncate">{item.label}</span>
              {#if item.shortcut}
                <kbd
                  class="rounded-sm border border-kitsuden-border bg-kitsuden-bg px-1.5 py-0.5 font-mono text-[10px] text-kitsuden-text-dim"
                >
                  {item.shortcut}
                </kbd>
              {/if}
              <span class="text-[10px] text-kitsuden-subtle">{typeLabel(item.type)}</span>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Footer -->
      <div
        class="flex items-center justify-between border-t border-kitsuden-border bg-kitsuden-bg/50 px-4 py-2"
      >
        <div class="flex items-center gap-3 text-[10px] text-kitsuden-subtle">
          <span class="flex items-center gap-1">
            <kbd
              class="rounded-sm border border-kitsuden-border bg-kitsuden-bg px-1 py-0.5 font-mono"
              >↑</kbd
            >
            <kbd
              class="rounded-sm border border-kitsuden-border bg-kitsuden-bg px-1 py-0.5 font-mono"
              >↓</kbd
            >
            <span>{t("commandPalette.toNavigate")}</span>
          </span>
          <span class="flex items-center gap-1">
            <kbd
              class="rounded-sm border border-kitsuden-border bg-kitsuden-bg px-1 py-0.5 font-mono"
              >↵</kbd
            >
            <span>{t("commandPalette.toSelect")}</span>
          </span>
        </div>
        <div class="text-[10px] text-kitsuden-subtle">
          {t("commandPalette.result", {
            filteredItemsCount: filteredItems.length,
          })}{filteredItems.length === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  </div>
{/if}
