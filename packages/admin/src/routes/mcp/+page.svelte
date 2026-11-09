<script lang="ts">
  import { t } from "$lib/i18n";
  import { onMount } from "svelte";

  import { goto } from "$app/navigation";

  // Redirect to Settings MCP tab
  onMount(() => {
    goto("/settings?tab=mcp");
  });
</script>

<div class="flex items-center justify-center h-64">
  <div class="animate-pulse text-kitsuden-subtle">{t("mcpPage.redirectingToMcpSettings")}</div>
</div>
