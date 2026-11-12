<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * MdxEditor.svelte — Split-screen MDX editor with content preview
   * CodeMirror 6 integration for Svelte
   */
  import { Alert, Spinner } from "$lib/tallao";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { onMount, tick } from "svelte";

  // ─── Props ──────────────────────────────────────────
  interface Props {
    value?: string;
    onChange?: (value: string) => void;
    /**
     * Files have arrived by pasting or dragging them onto the editor.
     *
     * The editor does not know where media comes from and should not: it notifies, and whoever
     * has the library uploads them and returns the image through `insertImage`.
     */
    onUploadFiles?: (files: File[]) => void;
  }

  const { value = "", onChange, onUploadFiles }: Props = $props();

  /**
   * The images from a clipboard or a drag.
   *
   * `DataTransfer` mixes text, HTML and files: a screenshot arrives as a
   * file, but copying an image from a website ALSO brings its `<img>` in HTML.
   * Filtering by `type` leaves only what needs uploading.
   */
  function imagesOf(data: DataTransfer | null): File[] {
    if (!data) return [];
    return Array.from(data.files).filter((f) => f.type.startsWith("image/"));
  }

  // ─── State ──────────────────────────────────────────
  let localContent = $state(value);
  let previewHtml = $state("");
  let isCompiling = $state(false);
  /** Reason why the preview is not the real site's, if any. */
  let previewError = $state<string | null>(null);
  let previewContainer: HTMLElement;
  let editorContainer: HTMLElement;
  let editorView: any;

  /**
   * Inserts an image at the cursor position.
   *
   * Called by the container, which is the one with the media library. There is no
   * toolbar here —this is CodeMirror— so the button lives outside
   * and this function is the only entry point.
   */
  export function insertImage(url: string, alt = "") {
    const markdown = `![${alt}](${url})`;

    if (!editorView) {
      // CodeMirror has not started yet (it is imported lazily). It is
      // written to the local value so as not to lose the chosen image.
      localContent += markdown;
      onChange?.(localContent);
      return;
    }

    const pos = editorView.state.selection.main.head;
    editorView.dispatch({
      changes: { from: pos, insert: markdown },
      selection: { anchor: pos + markdown.length },
    });
    editorView.focus();
  }

  // ─── Sync with external value ───────────────────────
  $effect(() => {
    if (value !== localContent) {
      localContent = value;
      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: value },
        });
      }
    }
  });

  // ─── Initialize CodeMirror ──────────────────────────
  onMount(() => {
    let destroyed = false;

    (async () => {
      const [{ basicSetup }] = await Promise.all([import("codemirror")]);
      const { EditorView, keymap } = await import("@codemirror/view");
      const { EditorState } = await import("@codemirror/state");
      const { markdown } = await import("@codemirror/lang-markdown");
      const { oneDark } = await import("@codemirror/theme-one-dark");

      if (destroyed) return;

      const state = EditorState.create({
        doc: localContent,
        extensions: [
          basicSetup,
          markdown(),
          oneDark,
          EditorView.updateListener.of((update: any) => {
            if (update.docChanged) {
              localContent = update.state.doc.toString();
              onChange?.(localContent);
              debouncedCompile(localContent);
            }
          }),
          /**
           * Paste and drag, via CodeMirror.
           *
           * Putting `onpaste` on the Svelte container does not work: CodeMirror
           * mounts its own `contenteditable` inside and takes the editing
           * events before they bubble up. `domEventHandlers` is its
           * entry point, and returning `true` is what tells it «this one is already
           * handled, don't do your own thing».
           */
          EditorView.domEventHandlers({
            paste: (event: ClipboardEvent) => {
              const images = imagesOf(event.clipboardData);
              // With no images `false` is returned: pasting text has to keep
              // working, which is what is done almost all the time.
              if (images.length === 0) return false;
              onUploadFiles?.(images);
              return true;
            },
            drop: (event: DragEvent) => {
              const images = imagesOf(event.dataTransfer);
              if (images.length === 0) return false;
              onUploadFiles?.(images);
              return true;
            },
            dragover: (event: DragEvent) => {
              // Without cancelling it, the browser OPENS the dropped file and takes
              // the half-written article down with it. It gives no warning.
              if (!onUploadFiles) return false;
              event.preventDefault();
              return true;
            },
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": {
              fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
              fontSize: "14px",
              lineHeight: "1.6",
            },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      });

      editorView = new EditorView({
        state,
        parent: editorContainer,
      });

      // Initial compile
      compilePreview(localContent);
    })();

    return () => {
      destroyed = true;
      if (editorView) {
        editorView.destroy();
      }
    };
  });

  // ─── Compilation logic ──────────────────────────────
  let debounceTimer: ReturnType<typeof setTimeout>;

  function debouncedCompile(content: string) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      compilePreview(content);
    }, 400);
  }

  /**
   * Renders the preview.
   *
   * ── WHY IT WAS ALWAYS BLANK ──────────────────────────────────────────────
   *
   * It requested the HTML from `${VITE_SITE_URL || "http://localhost:4321"}/api/preview`
   * — Astro's default port— with the idea of using «the frontend's real engine»
   * so that the preview matched the public site exactly.
   *
   * The intention is good; the problem is that in this repository there is NO
   * frontend: `apps/` only contains `api`, `VITE_SITE_URL` is defined
   * nowhere and nothing listens on 4321. The request always failed, the
   * error stayed in a `console.error`, and the right panel remained empty without
   * saying anything. You typed and nothing happened.
   *
   * ── WHAT IT DOES NOW ─────────────────────────────────────────────────────
   *
   * If `VITE_SITE_URL` is defined the real frontend is still used, which is
   * the most faithful. If not —or if it fails— it is composed right here with `marked`. An
   * approximate preview is infinitely more useful than a blank panel, and if
   * the remote goes down it says so on screen instead of pretending there is nothing to
   * show.
   */
  async function compilePreview(content: string) {
    if (!content.trim()) {
      previewHtml = "";
      previewError = null;
      return;
    }

    isCompiling = true;
    previewError = null;

    const siteUrl = import.meta.env.VITE_SITE_URL;

    try {
      if (siteUrl) {
        const res = await fetch(`${siteUrl}/api/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        previewHtml = (await res.json()).html || "";
      } else {
        previewHtml = await marked.parse(content);
      }
      await tick();
    } catch (err) {
      // The remote failed: it is composed locally and a notice is shown. Before, the
      // panel was left empty, which is indistinguishable from «you haven't written anything».
      try {
        previewHtml = await marked.parse(content);
        previewError =
          t("mdxEditor.couldNotUseThe", { err: err instanceof Error ? err.message : err }) +
          t("mdxEditor.approximatePreview");
      } catch (err2) {
        previewHtml = "";
        previewError = t("mdxEditor.couldNotComposeThe", {
          err2: err2 instanceof Error ? err2.message : err2,
        });
      }
    } finally {
      isCompiling = false;
    }
  }
</script>

<div
  class="mdx-editor h-full flex flex-col sm:flex-row overflow-hidden border border-kitsuden-border rounded-xl bg-kitsuden-card shadow-xs relative z-0"
>
  <!-- Code Editor Pane -->
  <div
    class="h-1/2 sm:h-full w-full sm:w-1/2 flex flex-col border-b sm:border-b-0 sm:border-r border-kitsuden-border"
  >
    <div
      class="flex items-center justify-between px-4 py-2 border-b border-kitsuden-border bg-kitsuden-bg"
    >
      <h3 class="text-xs font-semibold uppercase tracking-wider text-kitsuden-text-dim">
        {t("mdxEditor.markdownMdx")}
      </h3>
    </div>
    <div
      class="flex-1 overflow-auto bg-[#282c34] code-wrapper relative"
      bind:this={editorContainer}
    ></div>
  </div>

  <!--
    View of the CONTENT, not of the page: it converts the markdown and nothing else. It
    does not carry the site's styles or know about blocks, which are another field.
    Same reason as in `LivePreview.svelte`.
  -->
  <div class="h-1/2 sm:h-full w-full sm:w-1/2 flex flex-col bg-kitsuden-bg">
    <div
      class="flex items-center justify-between px-4 py-2 border-b border-kitsuden-border bg-kitsuden-bg shrink-0"
    >
      <h3 class="text-xs font-semibold uppercase tracking-wider text-kitsuden-text-dim">
        {t("common.contentPreview")}
      </h3>
      {#if isCompiling}
        <Spinner size="sm" class="text-kitsuden-accent" />
      {/if}
    </div>

    <div class="flex-1 overflow-auto p-4 sm:p-8">
      <!--
        If the preview does not come from the real site, it says so. Staying silent left the
        author looking at a panel that might not resemble what is published, with no way
        to know.
      -->
      {#if previewError}
        <Alert variant="warning" class="mb-4">{previewError}</Alert>
      {/if}

      <article
        bind:this={previewContainer}
        class="prose prose-invert prose-slate max-w-none prose-headings:font-bold prose-a:text-kitsuden-accent prose-img:rounded-xl prose-pre:bg-kitsuden-card prose-pre:border prose-pre:border-kitsuden-border"
      >
        <!-- Any editor can write it: it is sanitized before rendering. -->
        {@html DOMPurify.sanitize(previewHtml)}
      </article>

      {#if !localContent.trim()}
        <div class="h-full flex flex-col items-center justify-center text-kitsuden-subtle">
          <p class="text-sm">{t("mdxEditor.previewWillAppearHere")}</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  :global(.mdx-editor .cm-editor) {
    height: 100%;
  }
  :global(.mdx-editor .cm-editor.cm-focused) {
    outline: none !important;
  }
  :global(.mdx-editor .cm-scroller) {
    font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
    font-size: 14px;
    line-height: 1.6;
  }
</style>
