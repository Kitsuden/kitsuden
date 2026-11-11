<!--
  tallao — MenuItem
  An option of a DropdownMenu. Choosing it (click, Enter or Space) calls
  `onSelect` and closes the menu; with `closeOnSelect={false}` it stays open.
  A disabled option is announced and skipped while navigating, but not hidden.
-->
<script lang="ts">
  import { useMenu } from "../internal/menu";
  import { cn } from "../utils";

  interface Props {
    onSelect?: () => void;
    disabled?: boolean;
    variant?: "default" | "danger";
    closeOnSelect?: boolean;
    class?: string;
    children: import("svelte").Snippet;
  }

  const {
    onSelect,
    disabled = false,
    variant = "default",
    closeOnSelect = true,
    class: className = "",
    children,
  }: Props = $props();

  const menu = useMenu();

  function choose() {
    if (disabled) return;
    onSelect?.();
    if (closeOnSelect) menu?.close();
  }
</script>

<button
  type="button"
  role="menuitem"
  tabindex="-1"
  aria-disabled={disabled ? "true" : undefined}
  class={cn("ta-menu-item", `ta-menu-item--${variant}`, className)}
  onclick={choose}
>
  {@render children()}
</button>

<style>
  .ta-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    font: inherit;
    font-size: 0.875rem;
    text-align: left;
    color: rgb(var(--ta-text));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
    outline: none;
  }

  .ta-menu-item:hover,
  .ta-menu-item:focus-visible,
  .ta-menu-item:focus {
    background: rgb(var(--ta-elevated));
  }

  .ta-menu-item--danger {
    color: rgb(var(--ta-danger));
  }

  .ta-menu-item[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* On touch screens: 44px items for the finger. */
  @media (pointer: coarse) {
    .ta-menu-item { min-height: 2.75rem; }
  }
</style>
