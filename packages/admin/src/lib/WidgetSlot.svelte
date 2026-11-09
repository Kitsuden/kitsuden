<script lang="ts">
  /**
   * WidgetSlot.svelte
   *
   * Renders widgets registered in a specific slot.
   * Uses svelte:component to mount components dynamically.
   */
  import { fade } from "svelte/transition";

  import DynamicComponent from "./DynamicComponent.svelte";
  import { componentRegistry, type RegistryWidget } from "./registry.svelte";

  interface Props {
    /** Slot name (e.g. "dashboard:top", "sidebar:bottom") */
    name: string;
    /** CSS classes for the container */
    class?: string;
    /** Show entry animations */
    animated?: boolean;
    /** Wrapper for each widget */
    wrapper?: "none" | "card" | "border";
  }

  const {
    name,
    class: className = "",
    animated = true,
    wrapper = "none",
    empty,
  }: Props & { empty?: () => any } = $props();

  // Get widgets reactively
  let widgets = $state<RegistryWidget[]>([]);

  // Update widgets when they change
  $effect(() => {
    widgets = componentRegistry.getWidgets(name);
  });

  // Wrapper configuration
  const wrapperClasses = {
    none: "",
    card: "bg-kitsuden-card border border-kitsuden-border rounded-xl p-4",
    border: "border-b border-kitsuden-border last:border-b-0 py-4",
  };
</script>

<div class="widget-slot widget-slot--{name.replace(/:/g, '-')} {className}" data-slot={name}>
  {#if widgets.length === 0}
    <!-- Empty slot - optionally show placeholder -->
    {#if empty}
      {@render empty()}
    {/if}
  {:else}
    {#each widgets as widget (widget.id)}
      {@const Component = widget.component}
      <div
        class="widget-slot__item {wrapperClasses[wrapper]}"
        data-widget-id={widget.id}
        data-widget-module={widget.module}
      >
        {#if animated}
          <div transition:fade={{ duration: 200 }}>
            <DynamicComponent component={Component} props={widget.props} />
          </div>
        {:else}
          <DynamicComponent component={Component} props={widget.props} />
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .widget-slot {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .widget-slot__item {
    position: relative;
  }

  /* Slot-specific variants */
  .widget-slot--dashboard-top {
    margin-bottom: 1.5rem;
  }

  .widget-slot--dashboard-bottom {
    margin-top: 1.5rem;
  }

  .widget-slot--sidebar-bottom {
    margin-top: auto;
  }
</style>
