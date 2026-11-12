<script lang="ts">
  import { t } from "$lib/i18n";
  import KonIcon from "$lib/components/KonIcon.svelte";
  import { CheckCircle, PowerOff, Lock, Sparkles } from "lucide-svelte";
  import { Badge, Button, Card, CardContent, Spinner, Switch } from "$lib/tallao";
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

  const iconBg = $derived(
    module.enabled ? (module.color || "#A855F7") + "12" : "rgb(var(--ta-surface))"
  );
</script>

<Card class={module.enabled ? "module-card module-card--on" : "module-card"}>
  <CardContent class="module-card-body">
    <div class="module-card-head">
      <!-- lucide icon name, not emoji: see KonIcon. -->
      <div class="module-card-icon" style:background={iconBg} aria-hidden="true">
        <KonIcon name={module.icon} size={20} />
      </div>

      <div class="module-card-text">
        <div class="module-card-title">
          <p>{module.name}</p>
          {#if module.category === "core"}
            <Badge variant={module.enabled ? "accent" : "default"}>{t("moduleCard.core")}</Badge>
          {/if}
          {#if isThemeModule}
            <Badge variant="accent-2">
              <Sparkles size={10} aria-hidden="true" />
              {t("moduleCard.theme")}
            </Badge>
          {/if}
          {#if module.version}
            <Badge>v{module.version}</Badge>
          {/if}
        </div>

        <p class="module-card-desc">{module.description}</p>

        {#if module.dependsOn?.length}
          <div class="module-card-deps">
            <span>{t("moduleCard.requires")}</span>
            {#each module.dependsOn as dep}
              <Badge class="font-mono" variant={isDepEnabled(dep) ? "success" : "accent-2"}
                >{dep}</Badge
              >
            {/each}
          </div>
        {/if}
      </div>

      <div class="module-card-toggle">
        {#if isThemeModule}
          <Button
            variant="ghost"
            size="icon"
            ariaLabel={t("moduleCard.controlledByThemeActivation")}
            title={t("moduleCard.controlledByThemeActivation")}
            onclick={onToggle}
          >
            <Lock size={14} aria-hidden="true" />
          </Button>
        {:else if checking}
          <Spinner size="sm" />
        {:else}
          <Switch
            checked={module.enabled}
            disabled={toggling}
            ariaLabel={module.enabled
              ? t("moduleCard.clickToDisable")
              : t("moduleCard.clickToEnable")}
            onchange={() => onToggle?.()}
          />
        {/if}
      </div>
    </div>

    {#if module.enabled && !isThemeModule}
      <div transition:slide={{ duration: 200 }} class="module-card-foot">
        <span class="module-card-on"
          ><CheckCircle size={14} aria-hidden="true" /> {t("moduleCard.active")}</span
        >
        {#if module.tables?.length}<span class="font-mono"
            >{module.tables.length}
            {t("moduleCard.table")}{module.tables.length !== 1 ? "s" : ""}</span
          >{/if}
      </div>
    {/if}

    {#if isThemeModule && module.enabled}
      <div transition:slide={{ duration: 200 }} class="module-card-foot">
        <span class="module-card-theme"
          ><Sparkles size={14} aria-hidden="true" /> {t("moduleCard.enabledByTheme")}</span
        >
        {#if module.themeId}<span class="font-mono">{module.themeId}</span>{/if}
      </div>
    {/if}

    {#if !module.enabled && !isThemeModule}
      <div transition:slide={{ duration: 200 }} class="module-card-foot">
        <span class="module-card-off">
          <PowerOff size={14} aria-hidden="true" />
          {t("moduleCard.disabledDataHiddenNotRemoved")}
        </span>
      </div>
    {/if}
  </CardContent>
</Card>

<style>
  :global(.module-card) {
    min-width: 0;
  }
  :global(.module-card--on) {
    border-color: rgb(var(--ta-success) / 0.4);
  }
  .module-card-head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .module-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--ta-radius-lg);
    border: 1px solid rgb(var(--ta-border));
  }
  .module-card-text {
    flex: 1;
    min-width: 0;
  }
  .module-card-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .module-card-title p {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .module-card-desc {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: rgb(var(--ta-text-dim));
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .module-card-deps {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .module-card-toggle {
    flex-shrink: 0;
  }
  .module-card-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgb(var(--ta-border));
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .module-card-on,
  .module-card-theme,
  .module-card-off {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .module-card-on {
    color: rgb(var(--ta-success));
  }
  .module-card-theme {
    color: rgb(var(--ta-accent-2));
  }
</style>
