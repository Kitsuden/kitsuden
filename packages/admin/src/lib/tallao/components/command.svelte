<!--
  tallao — Command
  Command palette (⌘K / Ctrl+K): a dialog with a search box and a list of
  grouped actions that filters as you type, ignoring case and accents and
  also matching keywords. Combobox pattern with aria-activedescendant: focus
  stays in the search box while ↑ ↓ choose and Enter runs.

    <Command bind:open items={[
      { id: "new", label: "New project", group: "Projects", shortcut: "N", onSelect: create },
      { id: "theme", label: "Toggle theme", keywords: ["dark", "light"], onSelect: toggleTheme },
    ]} />

  Results supplied by the page (from an API, as you type): `filter={false}` so
  it does not filter, `bind:query` to know what is being searched and `loading`
  while they arrive. A result with `href` is a link (Enter follows it);
  `description` goes below the title and `badge` on the right.

    <Command bind:open bind:query filter={false} {loading} items={results}
      emptyText={(q) => `No results for "${q}"`} />

  `inline`: no dialog, just the search box and the list, for a page that adds
  its own backdrop and its own shortcut. Escape and choosing call onOpenChange(false).
-->
<script lang="ts" module>
  export interface CommandItem {
    id: string;
    label: string;
    group?: string;
    /** Other words it can be found by. */
    keywords?: string[];
    /** Small text under the title (subtitle). */
    description?: string;
    /** Shortcut shown on the right (text only). */
    shortcut?: string;
    /** Small tag on the right ("Game", "Post"). */
    badge?: string;
    /** With an address, the result is a link: click or Enter follows it. */
    href?: string;
    disabled?: boolean;
    onSelect?: () => void;
  }
</script>

<script lang="ts">
  import { untrack, type Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import { normalizeText } from "./combobox.svelte";
  import Dialog from "./dialog.svelte";

  const L = useLabels();
  let {
    open = $bindable(false),
    query = $bindable(""),
    inputRef = $bindable(),
    items,
    filter = true,
    loading = false,
    inline = false,
    autofocus = false,
    placeholder = L.search,
    label = L.commandPalette,
    emptyText = L.noResults,
    loadingLabel = L.loading,
    /** Global shortcut that opens it: Ctrl+K and ⌘K. `false` turns it off. */
    hotkey = true,
    class: className = "",
    onSelect,
    onOpenChange,
    empty,
    leading,
    trailing,
  }: {
    open?: boolean;
    /** What is typed in the search box. */
    query?: string;
    /** The search box <input> (to focus it from outside). */
    inputRef?: HTMLInputElement;
    items: CommandItem[];
    /** `false`: the page supplies results already filtered; the palette renders them as they are. */
    filter?: boolean;
    /** Results on the way: loading indicator and the list marked as busy. */
    loading?: boolean;
    /** No dialog or shortcut: the search box and the list inside the page's backdrop. */
    inline?: boolean;
    /** In `inline`, focus the search box on mount. */
    autofocus?: boolean;
    placeholder?: string;
    /** Accessible name of the palette. */
    label?: string;
    /**
     * No results. In a string, `{query}` is replaced with what was typed (in a Svelte
     * template, inside braces: `emptyText={"Nothing for \"{query}\""}`); or a function.
     */
    emptyText?: string | ((query: string) => string);
    /** Screen reader name of the loading indicator. */
    loadingLabel?: string;
    hotkey?: boolean;
    class?: string;
    /** After choosing any result (after its own onSelect). */
    onSelect?: (item: CommandItem) => void;
    /** It closes (Escape, choosing) or opens. In `inline`, so the page can remove its backdrop. */
    onOpenChange?: (open: boolean) => void;
    /** What shows with no results; receives the query (empty before typing). */
    empty?: Snippet<[string]>;
    /** Before each result's text (an icon); receives the result and whether it is active. */
    leading?: Snippet<[CommandItem, boolean]>;
    /** At the end of each result (an arrow, a number). */
    trailing?: Snippet<[CommandItem, boolean]>;
  } = $props();

  const id = $props.id();
  let listEl: HTMLElement | undefined = $state();
  let active = $state(0);

  const matches = (it: CommandItem, q: string) =>
    !q || [it.label, it.description ?? "", ...(it.keywords ?? [])].some((t) => normalizeText(t).includes(normalizeText(q)));
  const visible = $derived(filter ? items.filter((it) => matches(it, query)) : items);
  const groups = $derived(
    visible.reduce<{ group: string | undefined; items: { it: CommandItem; i: number }[] }[]>((acc, it, i) => {
      const last = acc.at(-1);
      if (last && last.group === it.group) last.items.push({ it, i });
      else acc.push({ group: it.group, items: [{ it, i }] });
      return acc;
    }, [])
  );
  const hasList = $derived(visible.length > 0);
  const emptyMessage = $derived(typeof emptyText === "function" ? emptyText(query) : emptyText.replaceAll("{query}", query));

  // Every time it opens, it starts clean. It depends only on `open`: if it
  // followed the search, every keystroke would clear it. In `inline` the page
  // mounts and unmounts it, and the query belongs to the page.
  $effect(() => {
    if (!open || inline) return;
    untrack(() => {
      query = "";
      active = nextEnabled(-1, 1);
    });
  });

  // New list (when filtering, or when results arrive from the page): the
  // first one that can be chosen becomes the active one.
  $effect(() => {
    void visible;
    untrack(() => (active = nextEnabled(-1, 1)));
  });

  $effect(() => {
    if (inline && autofocus) untrack(() => inputRef?.focus());
  });

  function nextEnabled(from: number, step: 1 | -1) {
    const n = visible.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + step * k + n * 2) % n;
      if (!visible[i].disabled) return i;
    }
    return -1;
  }

  function close() {
    if (!open && !inline) return;
    open = false;
    onOpenChange?.(false);
  }

  function run(it: CommandItem | undefined, e?: Event) {
    if (!it) return;
    if (it.disabled) {
      e?.preventDefault();
      return;
    }
    close();
    it.onSelect?.();
    onSelect?.(it);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = nextEnabled(active, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = visible[active];
      // A link is followed through its own click: the browser navigates and goes through run().
      if (it?.href && !it.disabled) listEl?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.click();
      else run(it);
    } else if (e.key === "Escape" && inline) {
      e.preventDefault();
      close();
    }
  }

  function onHotkey(e: KeyboardEvent) {
    if (hotkey && !inline && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      open = !open;
      onOpenChange?.(open);
    }
  }

  $effect(() => {
    if ((open || inline) && active >= 0)
      listEl?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  });
</script>

<svelte:window onkeydown={onHotkey} />

{#snippet body()}
  <div class="ta-command-field">
    <input
      bind:this={inputRef}
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      aria-expanded={hasList}
      aria-controls={hasList ? `${id}-list` : undefined}
      aria-activedescendant={hasList && active >= 0 ? `${id}-op-${active}` : undefined}
      aria-busy={loading || undefined}
      aria-label={label}
      {placeholder}
      class="ta-command-search"
      bind:value={query}
      onkeydown={onKey}
    />
    {#if loading && hasList}<span class="ta-command-spinner ta-command-spinner--field" aria-hidden="true"></span>{/if}
  </div>
  {#if hasList}
    <div
      bind:this={listEl}
      id={`${id}-list`}
      role="listbox"
      aria-label={label}
      aria-busy={loading || undefined}
      class="ta-command-list"
    >
      {#each groups as g, gi (gi)}
        <div role="group" aria-labelledby={g.group ? `${id}-g-${gi}` : undefined}>
          {#if g.group}<div class="ta-command-group" id={`${id}-g-${gi}`} role="presentation">{g.group}</div>{/if}
          {#each g.items as { it, i } (it.id)}
            {@const link = it.href && !it.disabled ? it.href : undefined}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <svelte:element
              this={link ? "a" : "div"}
              href={link}
              id={`${id}-op-${i}`}
              data-index={i}
              role="option"
              tabindex="-1"
              aria-selected={i === active}
              aria-disabled={it.disabled ? "true" : undefined}
              class="ta-command-item"
              class:ta-command-item--active={i === active}
              onmousedown={(e: MouseEvent) => e.preventDefault()}
              onpointermove={() => !it.disabled && (active = i)}
              onclick={(e: MouseEvent) => run(it, e)}
            >
              {#if leading}<span class="ta-command-leading">{@render leading(it, i === active)}</span>{/if}
              <span class="ta-command-text">
                {#if it.description}
                  <span class="ta-command-title">{it.label}</span>
                  <span class="ta-command-desc">{it.description}</span>
                {:else}{it.label}{/if}
              </span>
              {#if it.badge}<span class="ta-command-badge">{it.badge}</span>{/if}
              {#if it.shortcut}<kbd class="ta-command-shortcut" aria-hidden="true">{it.shortcut}</kbd>{/if}
              {#if trailing}<span class="ta-command-trailing">{@render trailing(it, i === active)}</span>{/if}
            </svelte:element>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
  <div class="ta-command-status" role="status">
    {#if loading && !hasList}
      <div class="ta-command-loading">
        <span class="ta-command-spinner" aria-hidden="true"></span>
        <span class="ta-command-hidden">{loadingLabel}</span>
      </div>
    {:else if loading}
      <span class="ta-command-hidden">{loadingLabel}</span>
    {:else if !hasList}
      {#if empty}{@render empty(query)}{:else if filter || query}<p class="ta-command-empty">{emptyMessage}</p>{/if}
    {/if}
  </div>
{/snippet}

{#if inline}
  <div class={cn("ta-command", "ta-command--inline", className)}>{@render body()}</div>
{:else}
  <Dialog bind:open ariaLabel={label} size="xl" class={cn("ta-command", className)} {onOpenChange}>
    {@render body()}
  </Dialog>
{/if}

<style>
  .ta-command-field { position: relative; }

  .ta-command-search {
    width: 100%;
    padding: 0.625rem 0.75rem;
    font: inherit;
    font-size: 0.9375rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-bg));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    outline: none;
  }
  .ta-command-search:focus {
    border-color: rgb(var(--ta-accent) / 0.5);
    box-shadow: 0 0 0 2px rgb(var(--ta-accent) / 0.15);
  }

  .ta-command-list {
    margin-top: 0.5rem;
    max-height: min(22rem, 60vh);
    max-height: min(22rem, 60dvh);
    overflow-y: auto;
  }

  .ta-command-group {
    padding: 0.5rem 0.5rem 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }

  .ta-command-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.625rem;
    font-size: 0.875rem;
    color: inherit;
    text-decoration: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-command-item--active { background: rgb(var(--ta-elevated)); }
  .ta-command-item[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }

  .ta-command-leading,
  .ta-command-trailing { display: inline-flex; flex-shrink: 0; align-items: center; color: rgb(var(--ta-text-dim)); }
  .ta-command-item--active .ta-command-trailing { color: rgb(var(--ta-accent)); }

  .ta-command-text { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
  .ta-command-title,
  .ta-command-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ta-command-title { font-weight: 500; }
  .ta-command-desc { font-size: 0.75rem; color: rgb(var(--ta-text-dim)); }

  .ta-command-badge {
    flex-shrink: 0;
    padding: 0.0625rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-elevated));
    border: 1px solid rgb(var(--ta-border));
    border-radius: 999px;
  }

  .ta-command-shortcut {
    padding: 0.05rem 0.4rem;
    font-family: var(--ta-font-mono);
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
  }

  .ta-command-empty {
    margin: 0;
    padding: 1rem 0.5rem;
    text-align: center;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-command-loading { display: flex; justify-content: center; padding: 1.5rem 0.5rem; }
  .ta-command-spinner {
    display: inline-block;
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid rgb(var(--ta-accent) / 0.3);
    border-top-color: rgb(var(--ta-accent));
    border-radius: 50%;
    animation: ta-command-spin 0.7s linear infinite;
  }
  .ta-command-spinner--field {
    position: absolute;
    top: 50%;
    right: 0.75rem;
    width: 1rem;
    height: 1rem;
    margin-top: -0.5rem;
  }
  @keyframes ta-command-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .ta-command-spinner { animation-duration: 2s; }
  }

  .ta-command-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  /* On touch screens: 16px so iOS does not zoom the page on focus. */
  @media (pointer: coarse) {
    .ta-command-search { font-size: 1rem; }
    .ta-command-item { min-height: 2.75rem; }
  }
</style>
