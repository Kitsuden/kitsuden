<!--
  Input: tallao's Input (src/lib/tallao). The file stays so the admin keeps one import path.
  `value` may come in undefined or null (an empty field of a record): tallao's Input wants a
  string, so the binding goes through a getter and a setter instead of passing it as is.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Input } from "$lib/tallao";

  type Props = Omit<ComponentProps<typeof Input>, "value"> & { value?: string | null };

  let { value = $bindable(), ...rest }: Props = $props();
</script>

<Input bind:value={() => value ?? "", (v) => (value = v)} {...rest} />
