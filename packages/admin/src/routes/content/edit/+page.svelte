<script lang="ts">
  /**
   * Content editor — the only one
   * ==========================================================================
   *
   * ── WHAT THERE WAS BEFORE ────────────────────────────────────────────────
   *
   * This route was a `+page.ts` that redirected to `/g/system-tools/editor`, and
   * there lived `EditorView`: a markdown editor with preview that
   * COMPLETELY IGNORED `?collection` and `?id` —it always started with its demo
   * text— and whose "Save Draft" button had no `onclick`.
   *
   * That is: "New Post" and editing an existing post both opened the same
   * sample document, and nothing you wrote was saved. Creating a
   * post was impossible.
   *
   * Meanwhile `BlogPostEditor` —title, slug, excerpt, status,
   * scheduling, author, featured image, tags, SEO overrides, with
   * create/update/delete against `/api/blog`— existed complete and nobody
   * linked to it.
   *
   * ── NOW ──────────────────────────────────────────────────────────────────
   *
   * A single editor. The markdown one with preview and the block one live
   * INSIDE it: the first as the writing mode of the `content` field (the
   * two editors emitted the same string, so they were not two editors) and the
   * second as its own tab over the `blocks` column.
   *
   * Without `?id` it is a new post. With `?id` that one is loaded.
   */
  import { page } from "$app/stores";

  import BlogPostEditor from "$lib/components/blog/BlogPostEditor.svelte";

  const postId = $derived($page.url.searchParams.get("id"));
</script>

<BlogPostEditor {postId} />
