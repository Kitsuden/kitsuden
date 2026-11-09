<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * DynamicBlock.svelte
   *
   * Example component that demonstrates dynamic rendering.
   * Renders content blocks based on their type.
   */
  import type { Component as SvelteComponent } from "svelte";

  import DynamicComponent from "../lib/DynamicComponent.svelte";
  import { componentRegistry } from "../lib/registry.svelte";

  interface Props {
    /** Block type to render */
    type: string;
    /** Block-specific props */
    props?: Record<string, any>;
    /** Mode: editor or preview */
    mode?: "editor" | "preview" | "render";
    /** Callback when the content changes (in editor mode) */
    onChange?: (data: any) => void;
  }

  const { type, props = {}, mode = "render", onChange }: Props = $props();

  // Get the block definition
  const block = $derived(componentRegistry.getBlock(type));

  // Select component by mode
  const BlockComponent = $derived.by<SvelteComponent | null>(() => {
    if (!block) return null;

    switch (mode) {
      case "editor":
        return block.editorComponent;
      case "preview":
      case "render":
      default:
        return block.renderComponent;
    }
  });

  // Handle changes in editor mode
  function handleChange(data: any) {
    if (onChange) {
      onChange(data);
    }
  }
</script>

{#if !block}
  <div
    class="p-4 bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/20 rounded-lg text-kitsuden-accent-2"
  >
    <p class="text-sm font-medium">{t("dynamicBlock.blockTypeNotFound", { type })}</p>
    <p class="text-xs mt-1">{t("dynamicBlock.makeSureTheModuleIs")}</p>
  </div>
{:else if !BlockComponent}
  <div
    class="p-4 bg-kitsuden-amber/10 border border-kitsuden-amber/20 rounded-lg text-kitsuden-amber"
  >
    <p class="text-sm">{t("dynamicBlock.componentNotAvailableForMode")} {mode}</p>
  </div>
{:else}
  <div class="dynamic-block" data-block-type={type} data-block-mode={mode}>
    <DynamicComponent
      component={BlockComponent}
      props={{
        ...props,
        ...(mode === "editor" ? { onChange: handleChange } : {}),
      }}
    />
  </div>
{/if}

<style>
  .dynamic-block {
    position: relative;
  }
</style>
