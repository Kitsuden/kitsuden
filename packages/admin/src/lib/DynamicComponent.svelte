<script lang="ts">
  /**
   * DynamicComponent.svelte
   *
   * Renders components dynamically using <svelte:component>.
   * Allows injecting externally registered components.
   */
  import type { Component } from "svelte";

  interface Props {
    /** Component to render */
    component: Component;
    /** Props to pass to the component */
    props?: Record<string, any>;
    /** Additional CSS classes */
    class?: string;
    /** Callback when the component mounts */
    onMount?: () => void;
  }

  const { component, props = {}, class: className = "", onMount }: Props = $props();

  // Reference to the instantiated component
  let componentRef: any = $state(null);

  // Run callback when mounted
  $effect(() => {
    if (componentRef && onMount) {
      onMount();
    }
  });
</script>

<div class="dynamic-component {className}" data-testid="dynamic-component">
  <svelte:component this={component} {...props} bind:this={componentRef} />
</div>

<style>
  .dynamic-component {
    /* Flexible container for the dynamic component */
    display: contents;
  }
</style>
