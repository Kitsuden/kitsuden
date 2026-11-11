<!--
  Agent Timeline Component
  Visualizes an agent's execution steps (Trace)
  Difference: Thought, Tool Call, Tool Response
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import {
    Brain,
    Wrench,
    MessageSquare,
    AlertCircle,
    ChevronRight,
    ChevronDown,
  } from "lucide-svelte";

  import Badge from "$lib/components/ui/Badge.svelte";
  import { cn } from "$lib/utils";

  interface Step {
    id: string;
    stepOrder: number;
    stepType:
      | "llm_call"
      | "tool_call"
      | "tool_result"
      | "thinking"
      | "retrieval"
      | "memory_read"
      | "memory_write"
      | "user_input"
      | "system"
      | "error";
    content?: string;
    reasoning?: string;
    toolName?: string;
    toolInput?: any;
    toolOutput?: any;
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    errorMessage?: string;
    createdAt: string;
  }

  interface Props {
    steps: any[];
    class?: string;
  }

  const { steps, class: className = "" }: Props = $props();

  let expandedSteps = $state<Set<string>>(new Set());

  function toggleStep(stepId: string) {
    if (expandedSteps.has(stepId)) {
      expandedSteps.delete(stepId);
    } else {
      expandedSteps.add(stepId);
    }
    expandedSteps = new Set(expandedSteps);
  }

  function formatDuration(ms?: number): string {
    if (!ms) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function formatTokens(inTokens?: number, outTokens?: number): string {
    const total = (inTokens || 0) + (outTokens || 0);
    if (total === 0) return "";
    return `${total.toLocaleString(localeFormat())} tokens`;
  }

  const stepConfig: Record<Step["stepType"], { icon: any; color: string; label: string }> = {
    llm_call: {
      icon: MessageSquare,
      color: "text-kitsuden-info bg-kitsuden-info/10 border-kitsuden-info/20",
      label: t("timeline.llmCall"),
    },
    tool_call: {
      icon: Wrench,
      color: "text-kitsuden-amber bg-kitsuden-amber/10 border-kitsuden-amber/20",
      label: t("timeline.toolCall"),
    },
    tool_result: {
      icon: Wrench,
      color: "text-kitsuden-green bg-kitsuden-green/10 border-kitsuden-green/20",
      label: t("timeline.toolResult"),
    },
    thinking: {
      icon: Brain,
      color: "text-kitsuden-purple bg-kitsuden-purple/10 border-kitsuden-purple/20",
      label: t("timeline.thinking"),
    },
    retrieval: {
      icon: Brain,
      color: "text-kitsuden-accent bg-kitsuden-accent/10 border-kitsuden-accent/20",
      label: t("timeline.retrieval"),
    },
    memory_read: {
      icon: Brain,
      color: "text-kitsuden-accent-2 bg-kitsuden-accent-2/10 border-kitsuden-accent-2/20",
      label: t("timeline.memoryRead"),
    },
    memory_write: {
      icon: Brain,
      color: "text-kitsuden-danger bg-kitsuden-danger/10 border-kitsuden-danger/20",
      label: t("timeline.memoryWrite"),
    },
    user_input: {
      icon: MessageSquare,
      color: "text-kitsuden-text-dim bg-kitsuden-subtle/10 border-kitsuden-subtle/20",
      label: t("timeline.userInput"),
    },
    system: {
      icon: Brain,
      color: "text-kitsuden-text-dim bg-kitsuden-subtle/10 border-kitsuden-subtle/20",
      label: t("common.system"),
    },
    error: {
      icon: AlertCircle,
      color: "text-kitsuden-danger bg-kitsuden-danger/10 border-kitsuden-danger/20",
      label: t("common.error"),
    },
  };
</script>

<div class={cn("space-y-3", className)}>
  {#each steps as step, i (step.id)}
    {@const config = stepConfig[step.stepType as keyof typeof stepConfig]}
    {@const isExpanded = expandedSteps.has(step.id)}
    {@const Icon = config.icon}

    <div class="relative">
      <!-- Connector line -->
      {#if i < steps.length - 1}
        <div class="absolute left-5 top-10 bottom-[-12px] w-px bg-kitsuden-border"></div>
      {/if}

      <!-- Step card -->
      <div
        class={cn(
          "rounded-lg border transition-all duration-200",
          "bg-kitsuden-card/50 hover:bg-kitsuden-card",
          config.color,
          isExpanded && "ring-1 ring-current"
        )}
      >
        <!-- Header -->
        <button
          class="w-full flex items-center gap-3 p-3 text-left"
          onclick={() => toggleStep(step.id)}
        >
          <div class={cn("p-2 rounded-lg", config.color)}>
            <Icon size={16} />
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium text-kitsuden-text">{config.label}</span>
              {#if step.toolName}
                <Badge variant="default" size="sm">{step.toolName}</Badge>
              {/if}
            </div>
            <div class="flex items-center gap-3 mt-0.5 text-xs text-kitsuden-subtle">
              <span>{t("timeline.step")} {step.stepOrder + 1}</span>
              {#if step.durationMs}
                <span>• {formatDuration(step.durationMs)}</span>
              {/if}
              {#if step.tokensIn || step.tokensOut}
                <span>• {formatTokens(step.tokensIn, step.tokensOut)}</span>
              {/if}
            </div>
          </div>

          <div class="text-kitsuden-subtle">
            {#if isExpanded}
              <ChevronDown size={18} />
            {:else}
              <ChevronRight size={18} />
            {/if}
          </div>
        </button>

        <!-- Expanded content -->
        {#if isExpanded}
          <div class="px-3 pb-3">
            <div class="pl-11 space-y-3">
              <!-- Content/Reasoning -->
              {#if step.content}
                <div>
                  <span class="text-xs font-medium text-kitsuden-subtle uppercase"
                    >{t("common.content")}</span
                  >
                  <p class="mt-1 text-sm text-kitsuden-text whitespace-pre-wrap">{step.content}</p>
                </div>
              {/if}

              {#if step.reasoning}
                <div>
                  <span class="text-xs font-medium text-kitsuden-subtle uppercase"
                    >{t("timeline.reasoning")}</span
                  >
                  <p class="mt-1 text-sm text-kitsuden-text whitespace-pre-wrap">
                    {step.reasoning}
                  </p>
                </div>
              {/if}

              <!-- Tool Input -->
              {#if step.toolInput}
                <div>
                  <span class="text-xs font-medium text-kitsuden-subtle uppercase"
                    >{t("timeline.toolInput")}</span
                  >
                  <pre
                    class="mt-1 p-2 bg-kitsuden-bg rounded-lg text-xs text-kitsuden-text overflow-x-auto">{JSON.stringify(
                      step.toolInput,
                      null,
                      2
                    )}</pre>
                </div>
              {/if}

              <!-- Tool Output -->
              {#if step.toolOutput}
                <div>
                  <span class="text-xs font-medium text-kitsuden-subtle uppercase"
                    >{t("timeline.toolOutput")}</span
                  >
                  <pre
                    class="mt-1 p-2 bg-kitsuden-bg rounded-lg text-xs text-kitsuden-text overflow-x-auto">{JSON.stringify(
                      step.toolOutput,
                      null,
                      2
                    )}</pre>
                </div>
              {/if}

              <!-- Error -->
              {#if step.errorMessage}
                <div>
                  <span class="text-xs font-medium text-kitsuden-danger uppercase"
                    >{t("common.error")}</span
                  >
                  <p class="mt-1 text-sm text-kitsuden-danger">{step.errorMessage}</p>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/each}
</div>
