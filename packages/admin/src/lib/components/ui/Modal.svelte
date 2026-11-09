<!--
  Modal: tallao's Dialog (src/lib/tallao), on the native <dialog> with showModal(): the rest
  of the page goes inert, Escape and a click on the backdrop close it, focus returns to
  where it was. Same props as before (open, title, description, size, showClose, onClose,
  onOpenChange, children, footer) plus tallao's (closeLabel, closeOnBackdrop, placement…).

  Its contract is unchanged: without `open` nothing is shown (Modal.contract.test.ts).
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Dialog } from "$lib/tallao";

  let { open = $bindable(false), ...rest }: ComponentProps<typeof Dialog> = $props();
</script>

<Dialog bind:open {...rest} />
