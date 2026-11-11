<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * Tags and platforms of a game (kon-games), in the game form
   * ==========================================================================
   *
   * The generic form only knows the columns of `games`; tags
   * and platforms are bridge tables (`games_to_tags`, `games_to_platforms`)
   * and showed up as «read-only»: there was no way to mark a game as
   * «Free», «Co-op» or «Play online» —filters your site uses— or to
   * say it is on Switch without touching the database by hand.
   *
   * Here they are chosen with a click (chips) and saved AFTER the game, with the
   * kon-games endpoint that already syncs both relations
   * (`PATCH /api/games/:id` with `tagIds` and `platformIds`). `save(id)` is
   * called by the form when it has the id: when editing, its own; when creating, the
   * one returned by the creation.
   */
  import { Loader2 } from "lucide-svelte";
  import { onMount } from "svelte";

  interface Option {
    id: string;
    name: string;
    slug: string;
    color?: string | null;
    shortName?: string | null;
  }

  interface Props {
    /** The game being edited; null when creating */
    gameId: string | null;
  }

  const { gameId }: Props = $props();

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  let tags = $state<Option[]>([]);
  let platforms = $state<Option[]>([]);
  let chosenTags = $state<Set<string>>(new Set());
  let chosenPlatforms = $state<Set<string>>(new Set());
  let loading = $state(true);
  let warning = $state<string | null>(null);

  onMount(async () => {
    try {
      const request = (route: string) =>
        fetch(`${API_URL}${route}`, { credentials: "include" }).then((r) => r.json());
      const [t, p, game] = await Promise.all([
        request("/api/games/tags"),
        request("/api/games/platforms"),
        gameId ? request(`/api/games/${gameId}`) : Promise.resolve(null),
      ]);
      tags = t.docs ?? [];
      platforms = p.docs ?? [];
      if (game) {
        chosenTags = new Set((game.tags ?? []).map((x: Option) => x.id));
        chosenPlatforms = new Set((game.platforms ?? []).map((x: Option) => x.id));
      }
    } catch {
      warning = t("gameTags.couldNotLoadThe");
    } finally {
      loading = false;
    }
  });

  function toggle(conjunto: Set<string>, id: string): Set<string> {
    const next = new Set(conjunto);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  /** Saves the game's two relations. Returns the error, or null if all went well. */
  export async function save(id: string): Promise<string | null> {
    if (loading || warning) return null; // with no catalog loaded, nothing is overwritten
    const res = await fetch(`${API_URL}/api/games/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        tagIds: [...chosenTags],
        platformIds: [...chosenPlatforms],
      }),
    });
    if (res.ok) return null;
    const err = await res.json().catch(() => ({}));
    return err.error || t("gameTags.couldNotSaveThe");
  }
</script>

<div class="mt-6 space-y-5 border-t border-kitsuden-border pt-5">
  {#if loading}
    <p class="flex items-center gap-2 text-sm text-kitsuden-subtle">
      <Loader2 class="h-4 w-4 animate-spin" />
      {t("gameTags.loadingTagsAndPlatforms")}
    </p>
  {:else if warning}
    <p class="text-sm text-kitsuden-accent-2">{warning}</p>
  {:else}
    <div>
      <p class="mb-1 text-sm font-medium text-kitsuden-text">{t("gameTags.tags")}</p>
      <p class="mb-2 text-[11px] text-kitsuden-subtle">
        {t("gameTags.freeInPairAndPlay")}
      </p>
      {#if tags.length === 0}
        <p class="text-xs text-kitsuden-subtle">{t("gameTags.noTagsCreateThemIn")}</p>
      {:else}
        <div class="flex flex-wrap gap-2">
          {#each tags as e (e.id)}
            <button
              type="button"
              class="chip"
              class:chip--activo={chosenTags.has(e.id)}
              style={e.color ? `--chip:${e.color}` : undefined}
              aria-pressed={chosenTags.has(e.id)}
              onclick={() => (chosenTags = toggle(chosenTags, e.id))}
            >
              {e.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div>
      <p class="mb-2 text-sm font-medium text-kitsuden-text">{t("gameTags.platforms")}</p>
      {#if platforms.length === 0}
        <p class="text-xs text-kitsuden-subtle">
          {t("gameTags.noPlatformsCreateThemIn")}
        </p>
      {:else}
        <div class="flex flex-wrap gap-2">
          {#each platforms as p (p.id)}
            <button
              type="button"
              class="chip"
              class:chip--activo={chosenPlatforms.has(p.id)}
              aria-pressed={chosenPlatforms.has(p.id)}
              title={p.name}
              onclick={() => (chosenPlatforms = toggle(chosenPlatforms, p.id))}
            >
              {p.shortName || p.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chip {
    --chip: var(--color-kitsuden-accent, #7c3aed);
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--chip) 45%, transparent);
    padding: 0.3rem 0.8rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: inherit;
    opacity: 0.75;
    transition:
      background 0.15s ease,
      opacity 0.15s ease;
  }
  .chip:hover {
    opacity: 1;
  }
  .chip--activo {
    background: var(--chip);
    border-color: var(--chip);
    color: #fff;
    opacity: 1;
  }
</style>
