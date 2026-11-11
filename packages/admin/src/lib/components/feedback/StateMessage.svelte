<!--
  Empty and error states, one shape for the whole panel.

  A failed load must never look like "nothing here": `kind="error"` says what failed and
  offers Retry; `kind="empty"` says there is nothing yet and, optionally, what to do next.
  A page shows one or the other, never both.

  Provisional: to be replaced by tallao's EmptyState when the list templates are rebuilt.
-->
<script lang="ts">
  import { AlertTriangle, Inbox, RefreshCw } from "lucide-svelte";
  import type { Snippet } from "svelte";

  import { t } from "$lib/i18n";
  import { Button } from "$lib/tallao";

  let {
    kind = "empty",
    title,
    description,
    onRetry,
    retrying = false,
    compact = false,
    class: className = "",
    icon,
    children,
  }: {
    kind?: "empty" | "error";
    title: string;
    /** For an error: the message of the failure. */
    description?: string | null;
    onRetry?: () => void;
    retrying?: boolean;
    /** Less padding, for a panel inside a page. */
    compact?: boolean;
    class?: string;
    icon?: Snippet;
    /** Actions (e.g. the "New …" button of an empty list). */
    children?: Snippet;
  } = $props();
</script>

<div
  class="flex flex-col items-center justify-center text-center rounded-xl border {kind === 'error'
    ? 'border-kitsuden-danger/30 bg-kitsuden-danger/5'
    : 'border-dashed border-kitsuden-border'} {compact
    ? 'px-4 py-6 gap-2'
    : 'px-6 py-12 gap-3'} {className}"
  role={kind === "error" ? "alert" : "status"}
  data-testid="state-{kind}"
>
  <div
    class={kind === "error" ? "text-kitsuden-danger" : "text-kitsuden-subtle"}
    aria-hidden="true"
  >
    {#if icon}
      {@render icon()}
    {:else if kind === "error"}
      <AlertTriangle class={compact ? "w-6 h-6" : "w-8 h-8"} />
    {:else}
      <Inbox class={compact ? "w-6 h-6" : "w-8 h-8"} />
    {/if}
  </div>
  <p class="text-sm font-medium text-kitsuden-text">{title}</p>
  {#if description}
    <p class="max-w-prose text-sm text-kitsuden-text-dim break-words">{description}</p>
  {/if}
  {#if (kind === "error" && onRetry) || children}
    <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
      {#if kind === "error" && onRetry}
        <Button variant="outline" size="sm" onclick={onRetry} disabled={retrying}>
          <RefreshCw class="w-3.5 h-3.5 {retrying ? 'animate-spin' : ''}" />
          {retrying ? t("common.retrying") : t("common.retry")}
        </Button>
      {/if}
      {@render children?.()}
    </div>
  {/if}
</div>
