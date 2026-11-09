<!--
  Select: tallao's Select (src/lib/tallao), a native <select> with the kit's tokens; options
  go in `options` or as <option> children. Like Input, `value` may come in undefined or null
  (an empty field of a record), so the binding goes through a getter and a setter.
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Select } from "$lib/tallao";

  type Props = Omit<ComponentProps<typeof Select>, "value"> & { value?: string | null };

  let { value = $bindable(), ...rest }: Props = $props();
</script>

<Select bind:value={() => value ?? "", (v) => (value = v)} {...rest} />
