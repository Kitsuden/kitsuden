<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * Framework-agnostic admin view host.
   *
   * Mounts a custom element contributed by a kon, loaded at runtime from its
   * compiled artifact. The kon may have written it in React, Vue, Svelte or
   * plain JS — it does not matter here, because what arrives is a bundle, not source.
   *
   * About the theme: it is NOT passed through props. The document's CSS variables
   * cross the Shadow DOM by inheritance, so the view only has to use
   * `var(--kitsuden-accent, …)` and it is integrated. It is the same pattern already
   * used in the embeddable portal of the newsletter kon.
   */
  import { createViewContext, type CustomViewDescriptor } from "@kitsuden/shared";

  import { customViewLoader } from "$lib/custom-view-loader";

  interface Props {
    descriptor: CustomViewDescriptor;
    viewId: string;
    /** Data the view receives as the `params` property. */
    params?: Record<string, unknown>;
    theme?: "light" | "dark";
    locale?: string;
    apiBase?: string;
  }

  let {
    descriptor,
    viewId,
    params = {},
    theme = "dark",
    locale = "es",
    apiBase = "/api",
  }: Props = $props();

  let mountPoint: HTMLDivElement | null = $state(null);
  let status: "loading" | "ready" | "error" = $state("loading");
  let errorMessage = $state("");
  let instance: HTMLElement | null = null;

  const context = $derived(
    createViewContext({ konId: descriptor.konId, viewId, apiBase, theme, locale })
  );

  /**
   * `$effect` and not `onMount`: we must reload when the view CHANGES.
   *
   * When switching from one tab to another of the same kon, Svelte reuses this
   * component instead of mounting it again, so `onMount` did not fire again.
   * The descriptor changed and nothing was loaded.
   *
   * The symptom was baffling: the error header said «clasificaciones»
   * and requested `<broadcast-clasificaciones>`, but the message was still that of
   * `scoreboard.js` — the previous attempt. It pointed to the wrong
   * file.
   *
   * It is the same bug `GrimoirePage` had when changing kon.
   */
  $effect(() => {
    // Reading the descriptor HERE is what creates the dependency.
    const actual = descriptor;
    let cancelled = false;

    // Clean state on every change: without this the previous view's error
    // would be visible while the new one loads.
    status = "loading";
    errorMessage = "";
    if (mountPoint) mountPoint.replaceChildren();
    instance = null;

    (async () => {
      try {
        const { tag } = await customViewLoader().load(actual);
        if (cancelled || !mountPoint) return;

        const el = document.createElement(tag);
        // They are passed as PROPERTIES, not attributes: attributes only accept
        // strings and here we pass objects.
        (el as HTMLElement & { context?: unknown }).context = context;
        (el as HTMLElement & { params?: unknown }).params = params;

        mountPoint.replaceChildren(el);
        instance = el;
        status = "ready";
      } catch (err) {
        if (cancelled) return;
        status = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        // The error goes to the console as well as the screen: whoever writes the view
        // needs the trace, not just the summary.
        console.error("[CustomViewHost] could not mount the view", actual, err);
      }
    })();

    return () => {
      cancelled = true;
      instance?.remove();
      instance = null;
    };
  });

  // The theme and params may change without unmounting the view: they are forwarded.
  $effect(() => {
    if (instance) {
      (instance as HTMLElement & { context?: unknown }).context = context;
      (instance as HTMLElement & { params?: unknown }).params = params;
    }
  });
</script>

<div class="custom-view">
  {#if status === "loading"}
    <div class="state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>{t("customViewHost.loadingView")}</span>
    </div>
  {:else if status === "error"}
    <div class="state error" role="alert">
      <strong>{t("customViewHost.couldNotLoadThe", { viewId })}</strong>
      <p>{errorMessage}</p>
      <p class="hint">
        {t("customViewHost.itContributes")} <code>{descriptor.konId}</code>
        {t("customViewHost.andShouldRegister")}
        <code>&lt;{descriptor.element}&gt;</code>.
      </p>
    </div>
  {/if}

  <!-- The custom element is injected here. It stays in the DOM even while
       loading so that the reference exists when the artifact arrives. -->
  <div class="mount" class:hidden={status !== "ready"} bind:this={mountPoint}></div>
</div>

<style>
  .custom-view {
    display: flex;
    flex-direction: column;
    min-height: 12rem;
    width: 100%;
  }

  .mount {
    flex: 1;
    min-width: 0;
  }

  .hidden {
    display: none;
  }

  .state {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    color: rgb(var(--kitsuden-text-dim) / 1);
  }

  .state.error {
    align-items: flex-start;
    text-align: left;
    border: 1px solid rgb(var(--kitsuden-border) / 1);
    border-radius: 0.5rem;
    background: rgb(var(--kitsuden-card) / 1);
    color: rgb(var(--kitsuden-text) / 1);
  }

  .state.error p {
    margin: 0;
    font-size: 0.875rem;
    color: rgb(var(--kitsuden-text-dim) / 1);
  }

  .hint code {
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid rgb(var(--kitsuden-border) / 1);
    border-top-color: rgb(var(--kitsuden-accent) / 1);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
