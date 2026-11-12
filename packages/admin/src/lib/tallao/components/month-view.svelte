<!--
  tallao — MonthView
  A whole month to look at (schedule, events, tournaments), with custom content in each day.
  It is not a picker: Calendar is the grid of the APG "date picker" pattern, where each day
  is a button and cannot contain links or buttons. Here each day is a cell of a plain table
  and the `day` snippet renders whatever it needs (links, buttons, badges), which is
  reached with Tab like the rest of the page.
    - ‹ › previous / next month (`previousLabel` / `nextLabel`, from the kit's labels).
    - PageUp / PageDown with focus inside: previous / next month (with Shift, year), as in
      Calendar. If the focused element belonged to a day no longer shown, focus moves to the month button.
  Each cell tells the screen reader its full date (hidden text) and today has aria-current="date".
  ISO dates "YYYY-MM-DD"; month and day names in the language (`locale`, Intl).
-->
<script lang="ts" module>
  import type { ISODate } from "../internal/dates";

  /** What the `day` snippet receives for each cell. */
  export interface MonthViewDay {
    /** "YYYY-MM-DD" */
    date: ISODate;
    /** Day of the month (1–31). */
    day: number;
    /** 0 Sunday … 6 Saturday. */
    weekday: number;
    today: boolean;
    /** From a neighboring month (filler of the first or last week). */
    outside: boolean;
  }
</script>

<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";
  import {
    addMonths,
    formatDate,
    capitalizeFirst,
    monthGrid,
    parseISO,
    sameMonth,
    todayISO,
    toISO,
    weekday,
  } from "../internal/dates";

  const L = useLabels();
  let {
    month = $bindable(),
    locale,
    weekStartsOn = 1,
    showOutsideDays = true,
    headingLevel = 2,
    previousLabel = L.previousMonth,
    nextLabel = L.nextMonth,
    class: className = "",
    onmonthchange,
    day,
    ...rest
  }: {
    /** Any day of the month shown (changing month leaves day 1); defaults to today. */
    month?: ISODate;
    locale?: string;
    /** First day of the week: 0 Sunday, 1 Monday (default). */
    weekStartsOn?: number;
    /** With false, days of neighboring months are empty cells. */
    showOutsideDays?: boolean;
    headingLevel?: 2 | 3 | 4 | 5 | 6;
    previousLabel?: string;
    nextLabel?: string;
    class?: string;
    /** When the month changes from the buttons or the keyboard, with day 1 of the new month. */
    onmonthchange?: (month: ISODate) => void;
    /** What goes in each day, below its number. */
    day?: Snippet<[MonthViewDay]>;
    /** Any other attribute (id, aria-*, data-*, style…) goes to the container. */
    [key: string]: unknown;
  } = $props();

  const id = $props.id();
  const firstOf = (iso: ISODate) => {
    const p = parseISO(iso)!;
    return toISO(p.y, p.m, 1);
  };

  // Without `month` (or with one that is not a date), the current month, fixed once on creation.
  const initial = untrack(() => firstOf(parseISO(month) ? month! : todayISO()));
  const shown = $derived(parseISO(month) ? firstOf(month!) : initial);

  // "Today" is computed in the browser, as in Calendar: the server's "today" may be
  // another day and the mark would not match on hydration.
  let today = $state<ISODate | null>(null);
  $effect(() => {
    today = todayISO();
  });

  let root: HTMLElement | undefined = $state();
  let prevButton: HTMLButtonElement | undefined = $state();
  let nextButton: HTMLButtonElement | undefined = $state();

  const weeks = $derived(monthGrid(shown, weekStartsOn));
  // Only the first letter: CSS capitalize gave "Noviembre De 2026"
  const title = $derived(
    capitalizeFirst(formatDate(shown, locale, { month: "long", year: "numeric" }))
  );
  const headers = $derived(
    weeks[0].map((d) => ({
      short: formatDate(d, locale, { weekday: "short" }),
      long: formatDate(d, locale, { weekday: "long" }),
    }))
  );
  const dayLabel = (iso: ISODate) =>
    formatDate(iso, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dayData = (iso: ISODate): MonthViewDay => ({
    date: iso,
    day: parseISO(iso)!.d,
    weekday: weekday(iso),
    today: iso === today,
    outside: !sameMonth(iso, shown),
  });

  async function shiftMonth(n: number) {
    const next = addMonths(shown, n);
    month = next;
    onmonthchange?.(next);
    await tick();
    // The focused element (an event of a day) may have gone with the previous month.
    if (root && !root.contains(document.activeElement)) (n < 0 ? prevButton : nextButton)?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    const n = e.shiftKey ? 12 : 1;
    shiftMonth(e.key === "PageUp" ? -n : n);
  }
</script>

<!-- The view's keyboard (PageUp / PageDown) bubbles up from the focused element inside. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div {...rest} class={cn("ta-monthview", className)} bind:this={root} onkeydown={onKey}>
  <div class="ta-monthview-header">
    <button
      type="button"
      class="ta-monthview-month"
      aria-label={previousLabel}
      bind:this={prevButton}
      onclick={() => shiftMonth(-1)}>‹</button
    >
    <svelte:element
      this={`h${headingLevel}`}
      class="ta-monthview-title"
      id={`${id}-title`}
      aria-live="polite">{title}</svelte:element
    >
    <button
      type="button"
      class="ta-monthview-month"
      aria-label={nextLabel}
      bind:this={nextButton}
      onclick={() => shiftMonth(1)}>›</button
    >
  </div>
  <table class="ta-monthview-grid" aria-labelledby={`${id}-title`}>
    <thead>
      <tr>
        {#each headers as c, i (i)}<th scope="col" abbr={c.long}>{c.short}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each weeks as week, s (s)}
        <tr>
          {#each week as iso (iso)}
            {@const d = dayData(iso)}
            {#if d.outside && !showOutsideDays}
              <td class="ta-monthview-empty"></td>
            {:else}
              <td
                class="ta-monthview-day"
                class:ta-monthview-outside={d.outside}
                data-date={iso}
                aria-current={d.today ? "date" : undefined}
              >
                <span class="ta-monthview-number" aria-hidden="true">{d.day}</span>
                <span class="ta-monthview-hidden">{dayLabel(iso)}</span>
                {#if day}<div class="ta-monthview-content">{@render day(d)}</div>{/if}
              </td>
            {/if}
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .ta-monthview {
    /* Minimum height of each day: change it with this variable. */
    --ta-monthview-cell-height: 6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: rgb(var(--ta-text));
  }

  .ta-monthview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .ta-monthview-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .ta-monthview-month {
    width: 2rem;
    height: 2rem;
    font: inherit;
    font-size: 1.125rem;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-monthview-month:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated));
  }
  .ta-monthview-month:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.7);
    outline-offset: 1px;
  }

  .ta-monthview-grid {
    width: 100%;
    table-layout: fixed;
    border-collapse: separate;
    border-spacing: 0.25rem;
  }

  .ta-monthview-grid th {
    padding: 0.25rem 0;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }

  .ta-monthview-day {
    height: var(--ta-monthview-cell-height);
    padding: 0.25rem;
    vertical-align: top;
    overflow: hidden;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    transition: background-color 0.15s;
  }
  .ta-monthview-day:hover {
    background: rgb(var(--ta-elevated) / 0.35);
  }

  .ta-monthview-number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--ta-text-dim));
    border-radius: 9999px;
  }
  .ta-monthview-day[aria-current="date"] .ta-monthview-number {
    color: rgb(var(--ta-on-accent));
    background: var(--ta-accent-fill, color-mix(in srgb, rgb(var(--ta-accent)) 88%, black));
    font-weight: 600;
  }
  .ta-monthview-outside {
    opacity: 0.55;
  }

  .ta-monthview-content {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    margin-top: 0.125rem;
  }

  .ta-monthview-hidden {
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
    .ta-monthview-month {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
