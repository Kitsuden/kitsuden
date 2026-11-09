<!--
  Checkbox: tallao's Checkbox (src/lib/tallao), a native checkbox with its clickable label
  (`label` or children; without either, pass `ariaLabel`).
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Checkbox } from "$lib/tallao";

  let { checked = $bindable(false), ...rest }: ComponentProps<typeof Checkbox> = $props();
</script>

<Checkbox bind:checked {...rest} />
