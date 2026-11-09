<!--
  Badge: tallao's Badge (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path.
  Variants: default, success, warning, error, info, purple, accent, accent-2, secondary; `tone="solid"` fills it.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Badge } from "$lib/tallao";

  const props: ComponentProps<typeof Badge> = $props();
</script>

<Badge {...props} />
