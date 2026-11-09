<!--
  CardContent: tallao's CardContent (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { CardContent } from "$lib/tallao";

  const props: ComponentProps<typeof CardContent> = $props();
</script>

<CardContent {...props} />
