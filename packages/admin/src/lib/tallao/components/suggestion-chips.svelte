<!--
  tallao — SuggestionChips
  A row of suggestions above a PromptInput: "follow up with this". Each chip is
  used once (with `singleUse`, the default): clicking it marks it as used and it
  disappears from the list, so the same suggestion is never sent twice.

  It is not a ToggleGroup: there is no selection to keep, only actions that get
  used up. A group with an accessible name and ← → arrows between chips.
-->
<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();

  interface Props {
    suggestions: string[];
    /** Called with the text of the clicked suggestion. */
    onSelect?: (suggestion: string) => void;
    /** Clicked suggestions disappear (default true). */
    singleUse?: boolean;
    /** Accessible name of the group. */
    label?: string;
    disabled?: boolean;
    class?: string;
    [key: string]: unknown;
  }

  const {
    suggestions,
    onSelect,
    singleUse = true,
    label = L.suggestions,
    disabled = false,
    class: className = "",
    ...rest
  }: Props = $props();

  let used = $state(new Set<string>());

  const visible = $derived(
    singleUse ? suggestions.filter((s) => !used.has(s)) : suggestions
  );

  function choose(s: string) {
    if (disabled) return;
    used = new Set([...used, s]);
    onSelect?.(s);
  }

  function onKey(e: KeyboardEvent) {
    const chips = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".ta-chips-chip")
    );
    const i = chips.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      chips[(i + 1) % chips.length]?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      chips[(i - 1 + chips.length) % chips.length]?.focus();
    }
  }
</script>

{#if visible.length}
  <div
    {...rest}
    role="group"
    aria-label={label}
    class={cn("ta-chips", className)}
    onkeydown={onKey}
  >
    {#each visible as s (s)}
      <button
        type="button"
        class="ta-chips-chip"
        {disabled}
        onclick={() => choose(s)}
      >
        {s}
      </button>
    {/each}
  </div>
{/if}

<style>
  .ta-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .ta-chips-chip {
    padding: 0.375rem 0.875rem;
    font: inherit;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: 9999px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background-color 0.15s;
  }

  .ta-chips-chip:hover:not(:disabled) {
    color: rgb(var(--ta-text));
    border-color: rgb(var(--ta-accent) / 0.5);
    background: rgb(var(--ta-accent) / 0.08);
  }

  .ta-chips-chip:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-chips-chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (pointer: coarse) {
    .ta-chips-chip { position: relative; }
    .ta-chips-chip::after { content: ""; position: absolute; top: 50%; left: 50%; width: max(100%, 2.75rem); height: max(100%, 2.75rem); transform: translate(-50%, -50%); }
  }
</style>
