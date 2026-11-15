<script lang="ts">
  import GrimoirePage from "$lib/components/admin/GrimoirePage.svelte";

  import { page } from "$app/state";

  // Access the dynamic [id] from the route URL
  const grimoireId = $derived(page.params.id ?? "");
</script>

<GrimoirePage {grimoireId} />
