<!--
  Textarea: tallao's Textarea (src/lib/tallao). The file stays so the admin keeps one import path.
  `value` may come in undefined or null (an empty field of a record): tallao's Textarea wants a
  string, so the binding goes through a getter and a setter instead of passing it as is.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Textarea } from "$lib/tallao";

  type Props = Omit<ComponentProps<typeof Textarea>, "value"> & { value?: string | null };

  let { value = $bindable(), ...rest }: Props = $props();
</script>

<Textarea bind:value={() => value ?? "", (v) => (value = v)} {...rest} />
