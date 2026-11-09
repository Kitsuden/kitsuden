<!--
  Avatar: tallao's Avatar (src/lib/tallao), with tallao's props. The file stays so the admin keeps one import path.
  It draws the initials itself from `name` when there is no `src` (the old AvatarFallback).
-->
<script lang="ts">
  import type { ComponentProps } from "svelte";

  import { Avatar } from "$lib/tallao";

  const props: ComponentProps<typeof Avatar> = $props();
</script>

<Avatar {...props} />
