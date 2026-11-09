<script lang="ts">
  import { t } from "$lib/i18n";
  import { ChevronLeft, ChevronRight } from "lucide-svelte";
  import { onMount } from "svelte";

  import type { CalendarView as CalendarViewType } from "$lib/types/admin";

  interface Props {
    view: CalendarViewType;
    apiEndpoint?: string;
  }

  const { view, apiEndpoint }: Props = $props();

  const API_URL = import.meta.env.VITE_API_URL ?? "";
  const endpoint = apiEndpoint || `/api/explorer/${view.table}`;

  let data = $state<any[]>([]);
  let loading = $state(true);
  let currentMonth = $state(new Date().getMonth());
  let currentYear = $state(new Date().getFullYear());

  // Validation state
  let hasValidDateField = $state(true);

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // Calendar grid computation
  const calendarDays = $derived.by(() => {
    const firstDay = new Date(currentYear, currentMonth, 1);
    const lastDay = new Date(currentYear, currentMonth + 1, 0);
    const startPad = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const days: Array<{ date: number | null; fullDate: string | null; isToday: boolean }> = [];

    // Padding days from previous month
    for (let i = 0; i < startPad; i++) {
      days.push({ date: null, fullDate: null, isToday: false });
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({
        date: d,
        fullDate: dateStr,
        isToday: dateStr === todayStr,
      });
    }

    return days;
  });

  // Group events by date
  const eventsByDate = $derived.by<Record<string, any[]>>(() => {
    const map: Record<string, any[]> = {};
    for (const item of data) {
      const raw = item[view.dateField];
      if (!raw) continue;
      const dateStr =
        typeof raw === "string" ? raw.slice(0, 10) : new Date(raw).toISOString().slice(0, 10);
      if (!map[dateStr]) map[dateStr] = [];
      map[dateStr].push(item);
    }
    return map;
  });

  onMount(async () => {
    await loadData();
  });

  async function loadData() {
    loading = true;
    hasValidDateField = true;
    try {
      const res = await fetch(`${API_URL}${endpoint}?limit=500`, { credentials: "include" });
      if (res.ok) {
        const result = await res.json();
        data = result.data || result.docs || result;

        // Validate that at least one item has the required dateField
        if (data.length > 0) {
          const sampleHasField = data.some((item) => view.dateField in item);
          if (!sampleHasField) {
            hasValidDateField = false;
          }
        }
      }
    } catch (e) {
      console.error("Failed to load calendar data", e);
    } finally {
      loading = false;
    }
  }

  function prevMonth() {
    if (currentMonth === 0) {
      currentMonth = 11;
      currentYear--;
    } else {
      currentMonth--;
    }
  }

  function nextMonth() {
    if (currentMonth === 11) {
      currentMonth = 0;
      currentYear++;
    } else {
      currentMonth++;
    }
  }

  function goToday() {
    const today = new Date();
    currentMonth = today.getMonth();
    currentYear = today.getFullYear();
  }

  function getEventColor(index: number): string {
    const colors = [
      "bg-kitsuden-accent/20 text-kitsuden-accent border-l-2 border-kitsuden-accent",
      "bg-purple-500/20 text-purple-400 border-l-2 border-purple-500",
      "bg-green-500/20 text-green-400 border-l-2 border-green-500",
      "bg-orange-500/20 text-orange-400 border-l-2 border-orange-500",
      "bg-pink-500/20 text-pink-400 border-l-2 border-pink-500",
    ];
    return colors[index % colors.length];
  }
</script>

<div class="space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold text-kitsuden-text">{view.title}</h2>
    <div class="flex items-center gap-2">
      <button class="btn-secondary-sm" onclick={goToday}>{t("calendarView.today")}</button>
      <button class="p-2 rounded-sm hover:bg-kitsuden-border/30" onclick={prevMonth}>
        <ChevronLeft class="w-4 h-4 text-kitsuden-text-dim" />
      </button>
      <span class="text-sm font-medium text-kitsuden-text min-w-[140px] text-center">
        {MONTHS[currentMonth]}
        {currentYear}
      </span>
      <button class="p-2 rounded-sm hover:bg-kitsuden-border/30" onclick={nextMonth}>
        <ChevronRight class="w-4 h-4 text-kitsuden-text-dim" />
      </button>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-64">
      <div
        class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
      ></div>
    </div>
  {:else if !hasValidDateField}
    <div
      class="flex items-center justify-center h-64 bg-kitsuden-bg/50 border border-kitsuden-border border-dashed rounded-xl"
    >
      <div class="text-center max-w-md p-6">
        <div class="text-4xl mb-4">⚠️</div>
        <h3 class="text-lg font-semibold text-kitsuden-text mb-2">
          {t("calendarView.incompatibleCalendarView")}
        </h3>
        <p class="text-sm text-kitsuden-subtle mb-4">
          {t("calendarView.thisCalendarViewIsConfigured")}
          <code class="bg-kitsuden-bg px-1.5 py-0.5 rounded-sm text-kitsuden-accent"
            >'{view.dateField}'</code
          >{t("calendarView.butTheUnderlyingTableDoes")}
        </p>
        <p class="text-xs text-kitsuden-text-dim">
          {t("calendarView.pleaseUpdateTheGrimoireConfig")}
        </p>
      </div>
    </div>
  {:else}
    <div class="border border-kitsuden-border rounded-xl overflow-hidden bg-kitsuden-card">
      <!-- Day Headers -->
      <div class="grid grid-cols-7 border-b border-kitsuden-border">
        {#each DAYS as day}
          <div
            class="p-2 text-center text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle bg-kitsuden-bg"
          >
            {day}
          </div>
        {/each}
      </div>

      <!-- Calendar Grid -->
      <div class="grid grid-cols-7">
        {#each calendarDays as cell, i}
          <div
            class="min-h-[100px] p-1.5 border-b border-r border-kitsuden-border/50 {cell.date ===
            null
              ? 'bg-kitsuden-bg/50'
              : 'hover:bg-kitsuden-border/10'} {cell.isToday ? 'bg-kitsuden-accent/5' : ''}"
          >
            {#if cell.date !== null}
              <div class="flex items-center justify-between mb-1">
                <span
                  class="text-xs font-medium {cell.isToday
                    ? 'bg-kitsuden-accent text-white w-6 h-6 rounded-full flex items-center justify-center'
                    : 'text-kitsuden-text-dim px-1'}"
                >
                  {cell.date}
                </span>
              </div>

              <!-- Events for this date -->
              {#if cell.fullDate && eventsByDate[cell.fullDate]}
                <div class="space-y-1">
                  {#each eventsByDate[cell.fullDate].slice(0, 3) as event, idx}
                    <div class="text-[10px] px-1.5 py-0.5 rounded-sm truncate {getEventColor(idx)}">
                      {event[view.titleField] ||
                        event.title ||
                        event.name ||
                        t("calendarView.event")}
                    </div>
                  {/each}
                  {#if eventsByDate[cell.fullDate].length > 3}
                    <div class="text-[9px] text-kitsuden-subtle px-1.5">
                      {t("common.more", { v: eventsByDate[cell.fullDate].length - 3 })}
                    </div>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Legend -->
    <div class="flex items-center gap-4 text-xs text-kitsuden-text-dim">
      <span>{data.length} {t("calendarView.eventsTotal")}</span>
      <span>·</span>
      <span
        >{t("calendarView.dateField")}
        <code class="text-kitsuden-accent">{view.dateField}</code></span
      >
      <span>·</span>
      <span
        >{t("calendarView.titleField")}
        <code class="text-kitsuden-accent">{view.titleField}</code></span
      >
    </div>
  {/if}
</div>
