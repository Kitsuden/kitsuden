<script lang="ts">
  import { onMount } from "svelte";

  import RecentActivityWidget from "./components/widgets/RecentActivityWidget.svelte";
  import { checkSession } from "./lib/auth.svelte";
  import { componentRegistry } from "./lib/registry.svelte";
  import { loadTheme } from "./lib/theme.svelte";
  // import ProtectedRoutes from "./lib/ProtectedRoutes.svelte";

  // Import widgets for registration

  onMount(async () => {
    // 1. Load theme first
    await loadTheme();

    // 2. Configure enabled modules
    componentRegistry.setEnabledModules(["games", "actions", "analytics", "core"]);

    // 3. Register dynamic widgets
    // In a real app, this would come from the API or from dynamically loaded modules
    componentRegistry.registerWidget({
      id: "kitsuden-recent-activity",
      slot: "dashboard:sidebar",
      component: RecentActivityWidget,
      order: 10,
      module: "core",
      props: { limit: 5 },
    });

    // 4. Check user session
    await checkSession();
  });
</script>

<!--
  App.svelte — Root Component

  Initializes the dynamic component registration system
  and handles SPA routing.
-->
<!-- ProtectedRoutes component missing -->
