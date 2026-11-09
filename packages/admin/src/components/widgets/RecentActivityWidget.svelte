<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * RecentActivityWidget
   *
   * Shows recent system activity.
   */
  import { Activity, FileText, User, Settings, ImageIcon } from "lucide-svelte";

  interface Props {
    limit?: number;
  }

  const { limit = 5 }: Props = $props();

  // Sample data
  const activities = [
    {
      type: "post",
      action: "Published",
      item: "New Blog Post",
      user: "John Doe",
      time: "5 min ago",
      icon: FileText,
    },
    {
      type: "user",
      action: "Created",
      item: "New User Account",
      user: "System",
      time: "15 min ago",
      icon: User,
    },
    {
      type: "media",
      action: "Uploaded",
      item: "5 images",
      user: "Jane Smith",
      time: "1 hour ago",
      icon: ImageIcon,
    },
    {
      type: "settings",
      action: "Updated",
      item: "Site Settings",
      user: "Admin",
      time: "2 hours ago",
      icon: Settings,
    },
    {
      type: "post",
      action: "Drafted",
      item: "Product Update",
      user: "John Doe",
      time: "3 hours ago",
      icon: FileText,
    },
  ];

  function getIconColor(type: string) {
    switch (type) {
      case "post":
        return "bg-kitsuden-accent/10 text-kitsuden-accent";
      case "user":
        return "bg-kitsuden-green/10 text-kitsuden-green";
      case "media":
        return "bg-kitsuden-purple/10 text-kitsuden-purple";
      case "settings":
        return "bg-kitsuden-amber/10 text-kitsuden-amber";
      default:
        return "bg-kitsuden-border text-kitsuden-subtle";
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h3 class="font-semibold text-kitsuden-text flex items-center gap-2">
      <Activity class="w-4 h-4 text-kitsuden-accent" />
      {t("recentActivityWidget.recentActivity")}
    </h3>
  </div>

  <!-- Activity List -->
  <div class="space-y-3">
    {#each activities.slice(0, limit) as activity}
      {@const Icon = activity.icon}
      <div class="flex items-start gap-3">
        <div
          class="w-8 h-8 rounded-lg {getIconColor(
            activity.type
          )} flex items-center justify-center shrink-0"
        >
          <Icon class="w-4 h-4" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm text-kitsuden-text">
            <span class="font-medium">{activity.action}</span>
            <span class="text-kitsuden-text-dim">{activity.item}</span>
          </p>
          <p class="text-xs text-kitsuden-subtle mt-0.5">
            {t("recentActivityWidget.by", { user: activity.user, time: activity.time })}
          </p>
        </div>
      </div>
    {/each}
  </div>

  <button class="w-full text-center text-xs text-kitsuden-accent hover:underline">
    {t("recentActivityWidget.viewAllActivity")}
  </button>
</div>

<style>
  .text-kitsuden-accent {
    color: var(--kitsuden-color-cyan);
  }
  .text-kitsuden-green {
    color: var(--kitsuden-color-green);
  }
  .text-kitsuden-purple {
    color: var(--kitsuden-color-purple);
  }
  .text-kitsuden-amber {
    color: var(--kitsuden-color-amber);
  }
  .text-kitsuden-text {
    color: var(--kitsuden-color-text);
  }
  .text-kitsuden-text-dim {
    color: var(--kitsuden-color-text-dim);
  }
  .text-kitsuden-subtle {
    color: var(--kitsuden-color-subtle);
  }

  .bg-kitsuden-accent\/10 {
    background-color: rgba(168, 85, 247, 0.1);
  }
  .bg-kitsuden-green\/10 {
    background-color: rgba(0, 230, 118, 0.1);
  }
  .bg-kitsuden-purple\/10 {
    background-color: rgba(179, 136, 255, 0.1);
  }
  .bg-kitsuden-amber\/10 {
    background-color: rgba(255, 171, 0, 0.1);
  }
  .bg-kitsuden-border {
    background-color: var(--kitsuden-color-border);
  }
</style>
