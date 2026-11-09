<!--
  Card: tallao's Card (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Card } from "$lib/tallao";

  const props: ComponentProps<typeof Card> = $props();
</script>

<Card {...props} />
