<!--
  tallao — Label
  A standalone <label>, for when the control is not inside a Field (a grid of settings, a
  label above a custom control):

    <Label for="email" required>E-mail</Label>
    <Input id="email" type="email" required />

  `required` draws a visible "*" (hidden from screen readers) plus a visually hidden
  "Required" text from the labels, so the requirement is not told by colour or symbol alone.
  `disabled` dims it to match a disabled control. Any other attribute goes to the <label>.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();

  interface Props {
    /** Id of the control it names. */
    for?: string;
    required?: boolean;
    disabled?: boolean;
    /** Hidden text after a required label; defaults to the `required` text. */
    requiredLabel?: string;
    class?: string;
    children: Snippet;
    [key: string]: unknown;
  }

  const {
    for: htmlFor,
    required = false,
    disabled = false,
    requiredLabel = L.required,
    class: className = "",
    children,
    ...rest
  }: Props = $props();
</script>

<label {...rest} for={htmlFor} class={cn("ta-label", disabled && "ta-label--off", className)}>
  {@render children()}{#if required}<span class="ta-label-required" aria-hidden="true">{" *"}</span
    ><span class="ta-hidden">{` (${requiredLabel})`}</span>{/if}
</label>

<style>
  .ta-label {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 500;
    color: rgb(var(--ta-text-dim));
  }

  .ta-label-required {
    color: rgb(var(--ta-danger));
  }

  .ta-label--off {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ta-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  @media (pointer: coarse) {
    .ta-label {
      font-size: 0.875rem;
    }
  }
</style>
