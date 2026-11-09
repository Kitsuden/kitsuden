<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * SlashCommandEditor.svelte
   * A lightweight rich-text editor with slash commands
   * Built on top of a native textarea for simplicity
   */
  import {
    Heading,
    List,
    ListOrdered,
    Image,
    Quote,
    Code,
    Bold,
    Italic,
    Link,
    CheckSquare,
    Minus,
  } from "lucide-svelte";

  interface Props {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    /**
     * Whoever is writing has asked for an image.
     *
     * The editor does NOT open the library on its own: it does not know where media
     * comes from and should not. It notifies, the container shows the picker and then
     * hands back the chosen one through `insertImage`.
     *
     * If not passed, the button does not appear — a button that leads nowhere
     * is worse than not having one.
     */
    onRequestImage?: () => void;
    /**
     * Files have arrived by pasting or dragging.
     *
     * Same split as `onRequestImage`: the editor detects the gesture and notifies;
     * uploading them is up to whoever has the library. Without this the editor would have to
     * know the media API, which is exactly what was avoided at the start.
     */
    onUploadFiles?: (files: File[]) => void;
  }

  const {
    value = "",
    onChange,
    onUploadFiles,
    placeholder = t("slashCommandEditor.typeForCommands"),
    onRequestImage,
  }: Props = $props();

  let textarea: HTMLTextAreaElement;
  let localValue = $state(value);
  let showSlashMenu = $state(false);
  let slashQuery = $state("");
  let slashMenuPosition = $state({ top: 0, left: 0 });
  let selectedCommandIndex = $state(0);

  // Sync external value
  $effect(() => {
    if (value !== localValue) {
      localValue = value;
    }
  });

  const commands = [
    {
      id: "heading1",
      label: t("slashCommandEditor.heading1"),
      icon: Heading,
      shortcut: "# ",
      description: t("slashCommandEditor.largeSectionHeading"),
    },
    {
      id: "heading2",
      label: t("slashCommandEditor.heading2"),
      icon: Heading,
      shortcut: "## ",
      description: t("slashCommandEditor.mediumSectionHeading"),
    },
    {
      id: "heading3",
      label: t("slashCommandEditor.heading3"),
      icon: Heading,
      shortcut: "### ",
      description: t("slashCommandEditor.smallSectionHeading"),
    },
    {
      id: "bullet",
      label: t("slashCommandEditor.bulletList"),
      icon: List,
      shortcut: "- ",
      description: t("slashCommandEditor.createABulletList"),
    },
    {
      id: "numbered",
      label: t("slashCommandEditor.numberedList"),
      icon: ListOrdered,
      shortcut: "1. ",
      description: t("slashCommandEditor.createANumberedList"),
    },
    {
      id: "todo",
      label: t("slashCommandEditor.toDoList"),
      icon: CheckSquare,
      shortcut: "- [ ] ",
      description: t("slashCommandEditor.createAToDoList"),
    },
    {
      id: "quote",
      label: t("slashCommandEditor.quote"),
      icon: Quote,
      shortcut: "> ",
      description: t("slashCommandEditor.createABlockquote"),
    },
    {
      id: "code",
      label: t("slashCommandEditor.codeBlock"),
      icon: Code,
      shortcut: "```\n\n```",
      description: t("slashCommandEditor.insertACodeBlock"),
    },
    {
      id: "divider",
      label: t("slashCommandEditor.divider"),
      icon: Minus,
      shortcut: "---\n",
      description: t("slashCommandEditor.insertAHorizontalDivider"),
    },
    {
      id: "image",
      label: t("slashCommandEditor.image"),
      icon: Image,
      shortcut: "![alt](url)",
      description: t("slashCommandEditor.insertAnImage"),
    },
  ];

  const filteredCommands = $derived(
    commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(slashQuery.toLowerCase()) ||
        cmd.id.toLowerCase().includes(slashQuery.toLowerCase())
    )
  );

  function handleInput(e: Event) {
    localValue = (e.target as HTMLTextAreaElement).value;
    onChange?.(localValue);
    checkSlashCommand();
  }

  function checkSlashCommand() {
    const cursorPosition = textarea.selectionStart;
    const textBeforeCursor = localValue.slice(0, cursorPosition);
    const lines = textBeforeCursor.split("\n");
    const currentLine = lines[lines.length - 1];

    const slashMatch = currentLine.match(/^\/(.*)$/);

    if (slashMatch) {
      slashQuery = slashMatch[1];
      showSlashMenu = true;
      selectedCommandIndex = 0;

      // Calculate position
      const rect = textarea.getBoundingClientRect();
      const lineHeight = 24;
      const linesAbove = lines.length;
      slashMenuPosition = {
        top: rect.top + linesAbove * lineHeight - textarea.scrollTop + 8,
        left: rect.left + 16,
      };
    } else {
      showSlashMenu = false;
    }
  }

  function executeCommand(command: (typeof commands)[0]) {
    /**
     * `/image` opens the library; it does not write `![alt](url)`.
     *
     * That text is not inserting an image: it is leaving homework. You have to go to another
     * screen, find the file, copy its URL and come back to paste it — with
     * a media library loaded on this very screen.
     */
    if (command.id === "image" && onRequestImage) {
      // The gap the menu opened (`/imagen`) is deleted beforehand: otherwise it would stay
      // written in the middle of the text next to the image.
      const until = textarea.selectionStart;
      const from = localValue.lastIndexOf("/", until - 1);
      if (from >= 0) {
        localValue = localValue.slice(0, from) + localValue.slice(until);
        onChange?.(localValue);
        savedPosition = from;
      } else {
        savedPosition = until;
      }
      showSlashMenu = false;
      onRequestImage();
      return;
    }

    const cursorPosition = textarea.selectionStart;
    const textBeforeCursor = localValue.slice(0, cursorPosition);
    const lines = textBeforeCursor.split("\n");
    const currentLineStart = textBeforeCursor.lastIndexOf("\n") + 1;

    const beforeCommand = localValue.slice(0, currentLineStart);
    const afterCommand = localValue.slice(cursorPosition);

    const insertion = command.shortcut;
    let newCursorPos = beforeCommand.length + insertion.length;

    // For code block, place cursor in the middle
    if (command.id === "code") {
      newCursorPos = beforeCommand.length + insertion.indexOf("\n") + 1;
    }

    localValue = beforeCommand + insertion + afterCommand;
    onChange?.(localValue);
    showSlashMenu = false;

    // Focus and set cursor
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!showSlashMenu) {
      // Toolbar shortcuts
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        switch (e.key) {
          case "b":
            e.preventDefault();
            wrapSelection("**", "**");
            break;
          case "i":
            e.preventDefault();
            wrapSelection("*", "*");
            break;
          case "k":
            e.preventDefault();
            wrapSelection("[", "](url)");
            break;
        }
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex + 1) % filteredCommands.length;
        break;
      case "ArrowUp":
        e.preventDefault();
        selectedCommandIndex =
          (selectedCommandIndex - 1 + filteredCommands.length) % filteredCommands.length;
        break;
      case "Enter":
        e.preventDefault();
        if (filteredCommands[selectedCommandIndex]) {
          executeCommand(filteredCommands[selectedCommandIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        showSlashMenu = false;
        break;
    }
  }

  function wrapSelection(before: string, after: string) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = localValue.slice(start, end);

    localValue = localValue.slice(0, start) + before + selectedText + after + localValue.slice(end);
    onChange?.(localValue);

    requestAnimationFrame(() => {
      textarea.focus();
      const newCursorPos = start + before.length + selectedText.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    });
  }

  /**
   * Where the cursor was when the image was requested.
   *
   * Opening the modal removes focus from the textarea. `selectionStart` survives
   * blur in current browsers, but relying on that is fragile: it is enough
   * for the modal to focus its first element for the image to end up
   * at the start of the text instead of where one was writing. It is saved.
   */
  let savedPosition = 0;

  /** Highlights the area while dragging over it. Without a signal, nobody drops. */
  let dragging = $state(false);

  /**
   * Notes where the cursor is NOW.
   *
   * It is exported because the «Image» button that people actually use does not live
   * here: it is in the blog editor's header, so it also appears in
   * Markdown mode. That button opens the modal without going through `requestImage()`,
   * so without this the saved position stayed at 0 and the image went in at the
   * START of the article — exactly the failure described by the
   * `savedPosition` comment, triggered by the path nobody had walked.
   */
  export function rememberPosition() {
    savedPosition = textarea?.selectionStart ?? localValue.length;
  }

  function requestImage() {
    rememberPosition();
    showSlashMenu = false;
    onRequestImage?.();
  }

  /**
   * Called by the container when an image has been chosen.
   *
   * It is exported on purpose: it is the only way for whoever owns the
   * media library to write at this editor's cursor position without
   * this component having to know the library.
   */
  export function insertImage(url: string, alt = "") {
    const markdown = `![${alt}](${url})`;
    const pos = Math.min(savedPosition, localValue.length);

    localValue = localValue.slice(0, pos) + markdown + localValue.slice(pos);
    onChange?.(localValue);

    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(pos + markdown.length, pos + markdown.length);
    });
  }

  /**
   * The images from a clipboard or a drag.
   *
   * `DataTransfer` mixes text, HTML and files: a screenshot arrives
   * as a file, but copying an image from a website ALSO brings its `<img>` in
   * HTML. Filtering by `type` leaves only what really needs uploading.
   */
  function imagesOf(data: DataTransfer | null): File[] {
    if (!data) return [];
    return Array.from(data.files).filter((f) => f.type.startsWith("image/"));
  }

  function onPaste(event: ClipboardEvent) {
    const images = imagesOf(event.clipboardData);
    if (images.length === 0) return; // normal text: let the browser paste it

    // The default paste is only cut off when there IS an image. Always cutting it
    // would break pasting text, which is what is done 99% of the time.
    event.preventDefault();
    rememberPosition();
    onUploadFiles?.(images);
  }

  function onDrop(event: DragEvent) {
    const images = imagesOf(event.dataTransfer);
    if (images.length === 0) return;

    event.preventDefault();
    dragging = false;

    // The cursor is NOT where it was dropped: dropping does not move the insertion point.
    // The last known position is used, which is where the person was
    // writing — more predictable than the end of the text.
    onUploadFiles?.(images);
  }

  /**
   * `dragover` must be cancelled or the browser OPENS the file, taking the
   * half-written article off the page. It is the classic drag-and-drop failure,
   * and it gives no warning.
   */
  function onDragOver(event: DragEvent) {
    if (!onUploadFiles) return;
    event.preventDefault();
    dragging = true;
  }

  function insertAtCursor(text: string) {
    const start = textarea.selectionStart;
    localValue = localValue.slice(0, start) + text + localValue.slice(start);
    onChange?.(localValue);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + text.length, start + text.length);
    });
  }
</script>

<div class="relative flex flex-col gap-2">
  <!-- Toolbar -->
  <div
    class="flex items-center gap-1 p-1.5 rounded-lg border border-kitsuden-border bg-kitsuden-card"
  >
    <button
      type="button"
      onclick={() => wrapSelection("**", "**")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.boldCtrlB")}
    >
      <Bold class="w-4 h-4" />
    </button>
    <button
      type="button"
      onclick={() => wrapSelection("*", "*")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.italicCtrlI")}
    >
      <Italic class="w-4 h-4" />
    </button>
    <button
      type="button"
      onclick={() => wrapSelection("[", "](url)")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.linkCtrlK")}
    >
      <Link class="w-4 h-4" />
    </button>

    <div class="w-px h-5 bg-kitsuden-border mx-1"></div>

    <button
      type="button"
      onclick={() => insertAtCursor("# ")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.heading1")}
    >
      <Heading class="w-4 h-4" />
    </button>
    <button
      type="button"
      onclick={() => insertAtCursor("- ")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.bulletList")}
    >
      <List class="w-4 h-4" />
    </button>
    <button
      type="button"
      onclick={() => insertAtCursor("> ")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.quote")}
    >
      <Quote class="w-4 h-4" />
    </button>
    {#if onRequestImage}
      <button
        type="button"
        onclick={requestImage}
        class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
        title={t("slashCommandEditor.insertLibraryImage")}
      >
        <Image class="w-4 h-4" />
      </button>
    {/if}
    <button
      type="button"
      onclick={() => insertAtCursor("```\n\n```")}
      class="p-1.5 rounded-sm hover:bg-kitsuden-border/50 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
      title={t("slashCommandEditor.codeBlock")}
    >
      <Code class="w-4 h-4" />
    </button>

    <div class="flex-1"></div>

    <span class="text-[10px] text-kitsuden-subtle px-2"
      >{t("slashCommandEditor.typeForCommands2")}</span
    >
  </div>

  <!-- Editor -->
  <div class="relative">
    <textarea
      bind:this={textarea}
      value={localValue}
      oninput={handleInput}
      onkeydown={handleKeyDown}
      onpaste={onPaste}
      ondrop={onDrop}
      ondragover={onDragOver}
      ondragleave={() => (dragging = false)}
      {placeholder}
      class="w-full min-h-[300px] p-4 rounded-xl border bg-kitsuden-card text-kitsuden-text placeholder:text-kitsuden-subtle resize-y focus:outline-hidden focus:ring-2 focus:ring-kitsuden-accent/20 focus:border-kitsuden-accent/50 font-mono text-sm leading-relaxed {dragging
        ? 'border-kitsuden-accent border-dashed'
        : 'border-kitsuden-border'}"
      spellcheck="false"></textarea>

    <!-- Slash Command Menu -->
    {#if showSlashMenu && filteredCommands.length > 0}
      <div
        class="fixed z-50 w-64 rounded-xl border border-kitsuden-border bg-kitsuden-card shadow-2xl overflow-hidden"
        style="top: {slashMenuPosition.top}px; left: {slashMenuPosition.left}px;"
      >
        <div
          class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-kitsuden-subtle border-b border-kitsuden-border"
        >
          {t("slashCommandEditor.basicBlocks")}
        </div>
        <div class="max-h-64 overflow-y-auto py-1">
          {#each filteredCommands as cmd, i}
            {@const Icon = cmd.icon}
            <button
              type="button"
              class="w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors {i ===
              selectedCommandIndex
                ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
                : 'text-kitsuden-text hover:bg-kitsuden-border/30'}"
              onclick={() => executeCommand(cmd)}
              onmouseenter={() => (selectedCommandIndex = i)}
            >
              <div
                class="w-8 h-8 rounded-lg border border-kitsuden-border flex items-center justify-center shrink-0 {i ===
                selectedCommandIndex
                  ? 'border-kitsuden-accent/30 bg-kitsuden-accent/5'
                  : 'bg-kitsuden-bg'}"
              >
                <Icon class="w-4 h-4" />
              </div>
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">{cmd.label}</p>
                <p class="text-xs text-kitsuden-subtle truncate">{cmd.description}</p>
              </div>
            </button>
          {/each}
        </div>
        <div
          class="px-3 py-2 border-t border-kitsuden-border bg-kitsuden-bg/50 text-[10px] text-kitsuden-subtle"
        >
          {t("slashCommandEditor.toNavigateEnterToSelect")}
        </div>
      </div>
    {/if}
  </div>
</div>
