<!--
  tallao — StreamingText
  An answer drawn as it arrives: each new word fades in where it lands, with a caret after
  the last one while the stream is open.

    <StreamingText text={answer} streaming={busy} />             the page appends to `answer`
    <StreamingText stream={response.textStream} onDone={save} />  or hand it an async iterable

  - `text` is the whole text so far and only grows; the words that were already there are not
    drawn again (they are keyed by position), so nothing flickers, and the text present when
    the component mounts (a message from history) does not animate at all.
  - `stream` is an `AsyncIterable<string>` of chunks: the component appends them, shows the
    caret until it ends and calls `onDone` with the full text. A new iterable starts over;
    leaving the page stops reading it.
  - No layout jump: words are inline text that wraps as usual, the fade is opacity only, and
    the caret is an inline box of fixed width at the end of the last line.
  - Screen readers do not get the animated words (`aria-hidden`): a hidden polite live region
    receives the text sentence by sentence, each one added once, so the answer is read in
    order and never from the start again. The block is `aria-busy` while streaming.
  - Plain text: line breaks are kept, nothing is interpreted as HTML or Markdown.
  - Reduced motion: words appear at once, the caret does not blink. On the server the text
    given is rendered whole.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { cn } from "../utils";

  interface Props {
    /** The text so far; it grows as the answer arrives. */
    text?: string;
    /** Chunks of text to append as they come, instead of `text`. */
    stream?: AsyncIterable<string>;
    /** The answer is still arriving (with `stream` the component knows by itself). */
    streaming?: boolean;
    /** Shows the caret while streaming. */
    caret?: boolean;
    class?: string;
    /** A `stream` ended; gets the full text. */
    onDone?: (text: string) => void;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const {
    text = "",
    stream,
    streaming = false,
    caret = true,
    class: className = "",
    onDone,
    ...rest
  }: Props = $props();

  let received = $state("");
  let reading = $state(false);

  $effect(() => {
    const source = stream;
    if (!source) return;
    let cancelled = false;
    received = "";
    reading = true;
    (async () => {
      try {
        for await (const chunk of source) {
          if (cancelled) return;
          received += chunk;
        }
      } finally {
        if (!cancelled) {
          reading = false;
          untrack(() => onDone?.(received));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  const full = $derived(stream ? received : text);
  const busy = $derived(stream ? reading : streaming);

  // Each word keeps its trailing space; a word still being written grows in place.
  const words = $derived(full.match(/\S+\s*|\s+/g) ?? []);

  // What a screen reader hears: whole sentences while streaming, everything at the end.
  const sentences = $derived.by(() => {
    const parts = full.match(/[^.!?…\n]+(?:[.!?…]+|\n+|$)\s*/g) ?? [];
    if (busy && parts.length && !/[.!?…\n]\s*$/.test(parts[parts.length - 1])) parts.pop();
    return parts.map((p) => p.trim()).filter(Boolean);
  });

  // Words present at the first render are already "seen": only what arrives later fades in.
  const initial = untrack(() => words.length);
</script>

<div {...rest} class={cn("ta-stream", busy && "ta-stream--busy", className)} aria-busy={busy}>
  <span class="ta-stream-text" aria-hidden="true">
    {#each words as word, i (i)}<span
        class={cn("ta-stream-word", i >= initial && "ta-stream-word--new")}>{word}</span
      >{/each}{#if busy && caret}<span class="ta-stream-caret"></span>{/if}
  </span>
  <span class="ta-stream-spoken" aria-live="polite" aria-atomic="false" aria-relevant="additions">
    {#each sentences as sentence, i (i)}<span>{sentence} </span>{/each}
  </span>
</div>

<style>
  .ta-stream {
    position: relative;
    min-width: 0;
    line-height: 1.6;
    color: rgb(var(--ta-text));
  }

  .ta-stream-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ta-stream-word--new {
    animation: ta-stream-in var(--ta-duration-slow, 240ms) var(--ta-ease-out, ease-out) both;
  }
  @keyframes ta-stream-in {
    from {
      opacity: 0;
      filter: blur(2px);
    }
    to {
      opacity: 1;
      filter: none;
    }
  }

  /* An inline box of fixed width: it follows the last word and never changes the line height. */
  .ta-stream-caret {
    display: inline-block;
    width: 0.4375em;
    height: 1.05em;
    margin-left: 0.0625em;
    vertical-align: -0.18em;
    background: rgb(var(--ta-accent));
    border-radius: 1px;
    animation: ta-stream-blink 1s steps(2, jump-none) infinite;
  }
  @keyframes ta-stream-blink {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.25;
    }
  }

  .ta-stream-spoken {
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

  @media (prefers-reduced-motion: reduce) {
    .ta-stream-word--new {
      animation: none;
    }
    .ta-stream-caret {
      animation: none;
    }
  }
</style>
