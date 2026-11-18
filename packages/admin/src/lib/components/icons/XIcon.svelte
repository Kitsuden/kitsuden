<script lang="ts">
  import type { SVGAttributes } from "svelte/elements";

  import BrandIcon from "./BrandIcon.svelte";

  let props: { size?: number | string } & SVGAttributes<SVGSVGElement> = $props();
</script>

<BrandIcon name="x" {...props} />
