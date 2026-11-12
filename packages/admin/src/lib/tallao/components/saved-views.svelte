<!--
  tallao — SavedViews
  Named views of a list (a set of filters, a sort, the columns): a menu button that lists
  them and lets the user save the current one, rename the active one or delete it.

    <SavedViews {views} bind:current query={filters}
      onSelect={(view) => (filters = view.query)}
      onSave={(view) => store.put(view)}
      onRename={(view, name) => store.rename(view.name, name)}
      onDelete={(view) => store.remove(view.name)} />

  - It keeps nothing: `views` is the caller's (`[{ name, query }]`, `query` any JSON) and
    every change is an event. The component only updates `current` (the active view's name).
  - The button is an APG menu button (DropdownMenu): each view is a `menuitemradio`, the
    active one checked. "Save current view…" and "Rename…" open a dialog with one field
    (Enter submits; an empty name is not accepted; saving under an existing name is the
    caller's to overwrite). "Delete" asks for confirmation first.
  - `query` is what "Save current view…" stores. Without `onSave`, `onRename` or `onDelete`
    the matching entry is not offered, so a read-only list of views is just `onSelect`.
-->
<script lang="ts" module>
  export interface SavedView<Q = unknown> {
    name: string;
    /** What the view restores: filters, sort, columns… any JSON. */
    query: Q;
  }
</script>

<script lang="ts" generics="Q">
  import { useLabels } from "../i18n";

  import Button from "./button.svelte";
  import ConfirmDialog from "./confirm-dialog.svelte";
  import Dialog from "./dialog.svelte";
  import DropdownMenu from "./dropdown-menu.svelte";
  import Field from "./field.svelte";
  import Icon from "./icon.svelte";
  import Input from "./input.svelte";
  import MenuItem from "./menu-item.svelte";
  import MenuLabel from "./menu-label.svelte";
  import MenuSeparator from "./menu-separator.svelte";

  interface Props {
    views: SavedView<Q>[];
    /** Name of the active view (bindable); `null` when none is. */
    current?: string | null;
    /** What "Save current view…" stores. */
    query?: Q;
    /** Text of the button when no view is active, and name of the menu. */
    label?: string;
    saveLabel?: string;
    /** "{name}" is replaced by the active view's name. */
    renameLabel?: string;
    deleteLabel?: string;
    deleteConfirmTitle?: string;
    nameLabel?: string;
    emptyText?: string;
    class?: string;
    onSelect?: (view: SavedView<Q>) => void;
    onSave?: (view: SavedView<Q>) => void;
    onRename?: (view: SavedView<Q>, name: string) => void;
    onDelete?: (view: SavedView<Q>) => void;
  }

  const L = useLabels();
  let {
    views,
    current = $bindable(null),
    query,
    label = L.savedViews,
    saveLabel = L.saveView,
    renameLabel = L.renameView,
    deleteLabel = L.deleteView,
    deleteConfirmTitle = L.deleteViewConfirm,
    nameLabel = L.viewName,
    emptyText = L.noSavedViews,
    class: className = "",
    onSelect,
    onSave,
    onRename,
    onDelete,
  }: Props = $props();

  const id = $props.id();
  const active = $derived(views.find((v) => v.name === current) ?? null);
  const named = (text: string) => text.replace("{name}", active?.name ?? "");

  let mode = $state<"save" | "rename" | null>(null);
  let name = $state("");
  let confirming = $state(false);

  function select(view: SavedView<Q>) {
    current = view.name;
    onSelect?.(view);
  }

  function ask(next: "save" | "rename") {
    name = next === "rename" ? (active?.name ?? "") : "";
    mode = next;
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    if (mode === "rename" && active) {
      if (clean !== active.name) onRename?.(active, clean);
    } else {
      onSave?.({ name: clean, query: query as Q });
    }
    current = clean;
    mode = null;
  }

  function remove() {
    if (!active) return;
    onDelete?.(active);
    current = null;
  }
</script>

<DropdownMenu {label}>
  {#snippet trigger(props)}
    <Button {...props} variant="secondary" size="sm" class={className}>
      <Icon name="eye" size={14} />{active?.name ?? label}<Icon name="chevron-down" size={12} />
    </Button>
  {/snippet}
  {#if views.length === 0}
    <MenuLabel>{emptyText}</MenuLabel>
  {/if}
  {#each views as view (view.name)}
    <MenuItem checked={view.name === current} checkType="radio" onSelect={() => select(view)}
      >{view.name}</MenuItem
    >
  {/each}
  {#if onSave || (active && (onRename || onDelete))}<MenuSeparator />{/if}
  {#if onSave}<MenuItem onSelect={() => ask("save")}>{saveLabel}</MenuItem>{/if}
  {#if active && onRename}<MenuItem onSelect={() => ask("rename")}>{named(renameLabel)}</MenuItem
    >{/if}
  {#if active && onDelete}<MenuItem variant="danger" onSelect={() => (confirming = true)}
      >{named(deleteLabel)}</MenuItem
    >{/if}
</DropdownMenu>

<Dialog
  open={mode !== null}
  title={mode === "rename" ? named(renameLabel).replace(/…$/, "") : saveLabel.replace(/…$/, "")}
  size="sm"
  onClose={() => (mode = null)}
>
  <form id={`${id}-form`} onsubmit={submit}>
    <Field label={nameLabel} required>
      <Input bind:value={name} required autocomplete="off" maxlength={80} />
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (mode = null)}>{L.cancel}</Button>
    <Button type="submit" form={`${id}-form`} disabled={!name.trim()}>{L.submit}</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirming}
  title={named(deleteConfirmTitle)}
  confirmLabel={L.delete}
  onConfirm={remove}
/>
