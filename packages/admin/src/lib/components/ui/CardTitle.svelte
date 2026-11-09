<!--
  CardTitle: tallao's CardTitle (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path. `level` sets the heading (h3 by default).
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { CardTitle } from "$lib/tallao";

  const props: ComponentProps<typeof CardTitle> = $props();
</script>

<CardTitle {...props} />
