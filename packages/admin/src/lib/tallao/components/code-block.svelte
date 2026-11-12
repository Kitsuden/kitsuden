<!--
  tallao — CodeBlock
  Output code (what a model writes, a README, a command): header with the
  language and a copy button, monospaced body with scrolling. No syntax
  highlighting on purpose: CodeEditor is for editing; this is only read
  and copied.
-->
<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();

  interface Props {
    /** The code as is. */
    code: string;
    /** Language tag ("ts", "sql"…), informational only. */
    language?: string;
    /** File name, if any. */
    fileName?: string;
    /** Text of the copy button. */
    copyLabel?: string;
    /** Notice after copying. */
    copiedLabel?: string;
    /** Maximum height before scrolling (CSS). */
    maxHeight?: string;
    /** Wrap long lines instead of scrolling horizontally. */
    wrap?: boolean;
    class?: string;
    [key: string]: unknown;
  }

  const {
    code,
    language,
    fileName,
    copyLabel = L.copy,
    copiedLabel = L.copied,
    maxHeight = "24rem",
    wrap = false,
    class: className = "",
    ...rest
  }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(timer));

  async function copy() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }
</script>

<figure {...rest} class={cn("ta-code", className)}>
  <figcaption class="ta-code-header">
    {#if fileName}
      <span class="ta-code-filename">{fileName}</span>
    {/if}
    {#if language}
      <span class="ta-code-language">{language}</span>
    {/if}
    <button
      type="button"
      class={cn("ta-code-copy", copied && "ta-code-copy--done")}
      title={copyLabel}
      aria-label={copied ? copiedLabel : copyLabel}
      onclick={copy}
    >
      {#if copied}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
        >
      {:else}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><rect width="14" height="14" x="8" y="8" rx="2" /><path
            d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
          /></svg
        >
      {/if}
      <span class="ta-code-copy-text">{copied ? copiedLabel : copyLabel}</span>
    </button>
  </figcaption>
  <pre class="ta-code-body" class:ta-code-body--wrap={wrap} style:max-height={maxHeight}><code
      >{code}</code
    ></pre>
</figure>

<style>
  .ta-code {
    margin: 0;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    background: rgb(var(--ta-bg));
    overflow: hidden;
  }

  .ta-code-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem 0.375rem 0.75rem;
    border-bottom: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
  }

  .ta-code-filename {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text));
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ta-code-language {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgb(var(--ta-text-dim));
  }

  .ta-code-copy {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    font: inherit;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  .ta-code-copy:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated));
  }

  .ta-code-copy:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-code-copy--done {
    color: rgb(var(--ta-success));
  }

  .ta-code-body {
    margin: 0;
    padding: 0.75rem 1rem;
    overflow: auto;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: rgb(var(--ta-text));
  }

  .ta-code-body code {
    font: inherit;
    white-space: pre;
  }

  .ta-code-body--wrap code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @media (pointer: coarse) {
    .ta-code-copy {
      position: relative;
    }
    .ta-code-copy::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 2.75rem);
      height: max(100%, 2.75rem);
      transform: translate(-50%, -50%);
    }
  }
</style>
