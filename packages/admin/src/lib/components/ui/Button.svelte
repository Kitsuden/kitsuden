<!--
  Button: tallao's Button (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path.
  Variants: primary, secondary, danger, danger-ghost, ghost, outline, soft; sizes sm, md, lg, icon.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Button } from "$lib/tallao";

  const props: ComponentProps<typeof Button> = $props();
</script>

<Button {...props} />
