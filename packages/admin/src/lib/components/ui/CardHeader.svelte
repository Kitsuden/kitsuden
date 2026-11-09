<!--
  CardHeader: tallao's CardHeader (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { CardHeader } from "$lib/tallao";

  const props: ComponentProps<typeof CardHeader> = $props();
</script>

<CardHeader {...props} />
