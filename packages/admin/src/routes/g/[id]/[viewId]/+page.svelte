<script lang="ts">
  import GrimoirePage from "$lib/components/admin/GrimoirePage.svelte";

  import { page } from "$app/stores";

  const grimoireId = $derived($page.params.id);
  const viewId = $derived($page.params.viewId);
</script>

<GrimoirePage {grimoireId} initialViewId={viewId} />
