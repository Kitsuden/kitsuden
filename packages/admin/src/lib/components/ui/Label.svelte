<!--
  Label: tallao's Label (src/lib/tallao), with tallao's props (`for`, `required` with its
  visible "*" and hidden "(Required)", `requiredLabel`, `disabled`, any other attribute).
  The admin's forms put the label on its own line above the control, so it stays a block
  with a small gap below unless the caller passes its own class.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Label } from "$lib/tallao";

  const { class: className = "block! mb-1.5", ...rest }: ComponentProps<typeof Label> = $props();
</script>

<Label class={className} {...rest} />
