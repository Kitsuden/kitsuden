<!-- One record of a kon's table at its own URL: /g/<kon>/<view>/<id>, or …/new. -->
<script lang="ts">
  import GrimoirePage from "$lib/components/admin/GrimoirePage.svelte";

  import { page } from "$app/stores";

  const grimoireId = $derived($page.params.id);
  const viewId = $derived($page.params.viewId);
  const recordId = $derived($page.params.recordId);
</script>

<GrimoirePage {grimoireId} initialViewId={viewId} {recordId} />
