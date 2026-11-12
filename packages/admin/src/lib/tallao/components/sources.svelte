<!--
  tallao — Sources
  The sources an answer cites (RAG): cards with favicon, title and domain,
  in a list with an accessible name. Without a favicon, the domain's initial
  in a stable color derived from its name.
-->
<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();

  export interface Source {
    url: string;
    title: string;
    /** If omitted, it comes from the URL itself. */
    domain?: string;
    favicon?: string;
  }

  interface Props {
    sources: Source[];
    /** Accessible name of the list. */
    label?: string;
    /** Compact: only favicon and domain, inline. */
    compact?: boolean;
    class?: string;
    [key: string]: unknown;
  }

  const {
    sources,
    label = L.sources,
    compact = false,
    class: className = "",
    ...rest
  }: Props = $props();

  const domainOf = (f: Source) => {
    try {
      return f.domain ?? new URL(f.url).hostname.replace(/^www\./, "");
    } catch {
      return f.domain ?? f.url;
    }
  };

  /** Stable color per domain (same idea as Avatar). */
  const COLORS = [
    "--ta-accent",
    "--ta-accent-2",
    "--ta-series-1",
    "--ta-series-3",
    "--ta-series-4",
    "--ta-series-5",
    "--ta-series-7",
  ];
  const colorOf = (domain: string) => {
    let h = 0;
    for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  };
</script>

{#if sources.length}
  <ul
    {...rest}
    class={cn("ta-sources", compact && "ta-sources--compact", className)}
    aria-label={label}
  >
    {#each sources as f (f.url)}
      {@const domain = domainOf(f)}
      <li>
        <a href={f.url} target="_blank" rel="noopener noreferrer" class="ta-sources-card">
          {#if f.favicon}
            <img src={f.favicon} alt="" class="ta-sources-favicon" loading="lazy" />
          {:else}
            <span
              class="ta-sources-initial"
              style:background="rgb(var({colorOf(domain)}) / 0.15)"
              style:color="rgb(var({colorOf(domain)}))"
              aria-hidden="true">{domain.charAt(0).toUpperCase()}</span
            >
          {/if}
          <span class="ta-sources-text">
            <span class="ta-sources-title">{f.title}</span>
            <span class="ta-sources-domain">{domain}</span>
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .ta-sources {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  }

  .ta-sources-card {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    background: rgb(var(--ta-surface));
    text-decoration: none;
    color: inherit;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .ta-sources-card:hover {
    border-color: rgb(var(--ta-accent) / 0.5);
    background: rgb(var(--ta-elevated));
  }

  .ta-sources-card:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }

  .ta-sources-favicon,
  .ta-sources-initial {
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--ta-radius-sm);
  }

  .ta-sources-favicon {
    object-fit: contain;
  }

  .ta-sources-initial {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .ta-sources-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .ta-sources-title {
    font-size: 0.8125rem;
    font-weight: 500;
    color: rgb(var(--ta-text));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ta-sources-domain {
    font-size: 0.6875rem;
    color: rgb(var(--ta-text-dim));
  }

  /* Compact: inline pills, no title */
  .ta-sources--compact {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .ta-sources--compact .ta-sources-card {
    padding: 0.25rem 0.625rem 0.25rem 0.25rem;
    border-radius: 9999px;
    gap: 0.375rem;
  }
  .ta-sources--compact .ta-sources-title {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .ta-sources--compact .ta-sources-favicon,
  .ta-sources--compact .ta-sources-initial {
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    font-size: 0.625rem;
  }
  @media (pointer: coarse) {
    .ta-sources-card {
      min-height: 2.75rem;
    }
    .ta-sources--compact .ta-sources-card {
      position: relative;
    }
    .ta-sources--compact .ta-sources-card::after {
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
