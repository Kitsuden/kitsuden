<script lang="ts">
  import { t } from "$lib/i18n";
  import KonIcon from "$lib/components/KonIcon.svelte";
  import { CheckCircle, PowerOff, Loader2, Lock, Sparkles } from "lucide-svelte";
  import { slide } from "svelte/transition";

  interface ModuleData {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    version?: string;
    category: "core" | "optional" | "theme";
    enabled: boolean;
    themeId?: string;
    tables?: string[];
    dependsOn?: string[];
    color?: string;
  }

  interface Props {
    module: ModuleData;
    toggling?: boolean;
    checking?: boolean;
    isDepEnabled?: (key: string) => boolean;
    onToggle?: () => void;
  }

  const {
    module,
    toggling = false,
    checking = false,
    isDepEnabled = () => false,
    onToggle,
  }: Props = $props();

  const isThemeModule = $derived(module.category === "theme");

  const stripeClass = $derived.by(() => {
    if (isThemeModule && module.enabled)
      return "bg-linear-to-r from-kitsuden-accent-2/60 via-kitsuden-purple/30 to-transparent";
    if (module.enabled) return "bg-linear-to-r from-green-500/60 via-green-400/30 to-transparent";
    return "bg-linear-to-r from-kitsuden-subtle/20 to-transparent";
  });

  const iconBg = $derived(
    module.enabled ? (module.color || "#A855F7") + "12" : "rgba(63,63,70,0.3)"
  );
  const iconBorder = $derived(
    module.enabled ? (module.color || "#A855F7") + "25" : "rgba(63,63,70,0.5)"
  );
</script>

<div
  class="card p-5 relative overflow-hidden transition-all duration-300 {module.enabled
    ? 'ring-1 ring-kitsuden-green/30'
    : 'opacity-75'} {isThemeModule ? 'ring-1 ring-kitsuden-accent-2/20' : ''}"
>
  <div class="absolute top-0 left-0 right-0 h-0.5 transition-all duration-500 {stripeClass}"></div>

  <div class="flex items-start gap-3">
    <div
      class="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 transition-all duration-300 {module.enabled
        ? 'scale-100'
        : 'scale-95 grayscale'}"
      style="background: {iconBg}; border: 1px solid {iconBorder}"
    >
      <!-- lucide icon name, not emoji: see KonIcon. -->
      <KonIcon name={module.icon} size={20} />
    </div>

    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <p class="font-semibold text-kitsuden-text text-sm">{module.name}</p>
        {#if module.category === "core"}
          <span
            class="text-[9px] font-bold px-1.5 py-0.5 rounded-full {module.enabled
              ? 'bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/20'
              : 'bg-kitsuden-border/50 text-kitsuden-subtle border border-kitsuden-border'}"
            >{t("moduleCard.core")}</span
          >
        {/if}
        {#if isThemeModule}
          <span
            class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border border-kitsuden-accent-2/20 flex items-center gap-1"
          >
            <Sparkles class="w-2.5 h-2.5" />
            {t("moduleCard.theme")}
          </span>
        {/if}
        {#if module.version}
          <span
            class="text-[9px] px-1.5 py-0.5 rounded-sm bg-kitsuden-subtle/20 text-kitsuden-text-dim border border-kitsuden-border"
            >v{module.version}</span
          >
        {/if}
      </div>

      <p class="text-xs text-kitsuden-subtle mt-1 line-clamp-2 leading-relaxed">
        {module.description}
      </p>

      {#if module.dependsOn?.length}
        <div class="mt-2 flex items-center gap-1 flex-wrap">
          <span class="text-[10px] text-kitsuden-subtle">{t("moduleCard.requires")}</span>
          {#each module.dependsOn as dep}
            <span
              class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-kitsuden-bg border border-kitsuden-border {isDepEnabled(
                dep
              )
                ? 'text-kitsuden-green'
                : 'text-kitsuden-accent-2'}">{dep}</span
            >
          {/each}
        </div>
      {/if}
    </div>

    <div class="shrink-0 mt-0.5">
      {#if isThemeModule}
        <button
          class="w-11 h-6 rounded-full bg-kitsuden-accent-2/20 flex items-center justify-center cursor-not-allowed"
          title={t("moduleCard.controlledByThemeActivation")}
          onclick={onToggle}
        >
          <Lock class="w-3 h-3 text-kitsuden-accent-2" />
        </button>
      {:else}
        <button
          onclick={onToggle}
          disabled={toggling || checking}
          class="relative w-11 h-6 rounded-full transition-colors duration-300 {module.enabled
            ? 'bg-kitsuden-green/30'
            : 'bg-kitsuden-border'} {toggling || checking
            ? 'opacity-50 cursor-wait'
            : 'cursor-pointer'}"
          title={module.enabled ? t("moduleCard.clickToDisable") : t("moduleCard.clickToEnable")}
        >
          {#if checking}
            <span class="absolute inset-0 flex items-center justify-center"
              ><Loader2 class="w-3.5 h-3.5 text-kitsuden-amber animate-spin" /></span
            >
          {:else}
            <span
              class="absolute top-0.5 w-5 h-5 rounded-full shadow-lg transition-all duration-300 {module.enabled
                ? 'translate-x-[1.35rem] bg-kitsuden-green shadow-kitsuden-green/30'
                : 'translate-x-0.5 bg-kitsuden-subtle'}"
            ></span>
          {/if}
        </button>
      {/if}
    </div>
  </div>

  {#if module.enabled && !isThemeModule}
    <div
      transition:slide={{ duration: 200 }}
      class="mt-3 pt-3 border-t border-kitsuden-border/50 flex items-center justify-between"
    >
      <span class="flex items-center gap-1.5 text-xs text-kitsuden-green"
        ><CheckCircle class="w-3.5 h-3.5" /> {t("moduleCard.active")}</span
      >
      {#if module.tables?.length}<span class="text-[10px] text-kitsuden-subtle font-mono"
          >{module.tables.length}
          {t("moduleCard.table")}{module.tables.length !== 1 ? "s" : ""}</span
        >{/if}
    </div>
  {/if}

  {#if isThemeModule && module.enabled}
    <div
      transition:slide={{ duration: 200 }}
      class="mt-3 pt-3 border-t border-kitsuden-accent-2/20 flex items-center justify-between"
    >
      <span class="flex items-center gap-1.5 text-xs text-kitsuden-accent-2"
        ><Sparkles class="w-3.5 h-3.5" /> {t("moduleCard.enabledByTheme")}</span
      >
      {#if module.themeId}<span class="text-[10px] text-kitsuden-subtle font-mono"
          >{module.themeId}</span
        >{/if}
    </div>
  {/if}

  {#if !module.enabled && !isThemeModule}
    <div
      transition:slide={{ duration: 200 }}
      class="mt-3 pt-3 border-t border-kitsuden-border/50 flex items-center gap-1.5 text-xs text-kitsuden-subtle"
    >
      <PowerOff class="w-3.5 h-3.5" />
      {t("moduleCard.disabledDataHiddenNotRemoved")}
    </div>
  {/if}
</div>

<style>
  .line-clamp-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
