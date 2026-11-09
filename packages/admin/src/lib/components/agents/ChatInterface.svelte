<!--
  Chat Interface Component
  Interactive chat panel for testing agents
-->
<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { Send, Bot, User, Loader2, Wrench, Sparkles } from "lucide-svelte";
  import { tick } from "svelte";

  import Button from "$lib/components/ui/Button.svelte";
  import { cn } from "$lib/utils";

  interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: Date;
    metadata?: {
      tokensIn?: number;
      tokensOut?: number;
      durationMs?: number;
      provider?: string;
      model?: string;
      cached?: boolean;
    };
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result: string }>;
  }

  interface Props {
    messages: Message[];
    loading?: boolean;
    agentName?: string;
    onSend: (message: string) => void;
    class?: string;
  }

  let {
    messages = $bindable([]),
    loading = false,
    agentName = "Agent",
    onSend,
    class: className = "",
  }: Props = $props();

  let inputValue = $state("");
  let messagesContainer: HTMLDivElement;

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!inputValue.trim() || loading) return;

    onSend(inputValue.trim());
    inputValue = "";
  }

  function scrollToBottom() {
    tick().then(() => {
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    });
  }

  $effect(() => {
    if (messages.length) {
      scrollToBottom();
    }
  });

  function formatTime(date: Date): string {
    return date.toLocaleTimeString(localeFormat(), { hour: "2-digit", minute: "2-digit" });
  }
</script>

<div
  class={cn(
    "flex flex-col h-full bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden",
    className
  )}
>
  <!-- Header -->
  <div class="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
    <div class="p-2 bg-indigo-500/10 rounded-lg">
      <Bot size={18} class="text-indigo-400" />
    </div>
    <div>
      <h3 class="font-medium text-zinc-100">{agentName}</h3>
      <p class="text-xs text-zinc-500">{t("chatInterface.testPlayground")}</p>
    </div>
    {#if loading}
      <div class="ml-auto flex items-center gap-2 text-xs text-zinc-500">
        <Loader2 size={14} class="animate-spin" />
        <span>{t("chatInterface.thinking")}</span>
      </div>
    {/if}
  </div>

  <!-- Messages -->
  <div bind:this={messagesContainer} class="flex-1 overflow-y-auto p-4 space-y-4">
    {#if messages.length === 0}
      <div class="flex flex-col items-center justify-center h-full text-center text-zinc-500">
        <Bot size={48} class="mb-4 opacity-50" />
        <p class="text-sm">{t("chatInterface.sendsAMessageToStart")}</p>
        <p class="text-xs mt-2 opacity-70">
          {t("chatInterface.theAgentWillRespondUsingTheir")}
        </p>
      </div>
    {:else}
      {#each messages as message (message.id)}
        <div class={cn("flex gap-3", message.role === "user" ? "flex-row-reverse" : "")}>
          <!-- Avatar -->
          <div
            class={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
              message.role === "user" ? "bg-zinc-700" : "bg-indigo-500/10"
            )}
          >
            {#if message.role === "user"}
              <User size={16} class="text-zinc-300" />
            {:else}
              <Bot size={16} class="text-indigo-400" />
            {/if}
          </div>

          <!-- Message content -->
          <div
            class={cn(
              "max-w-[80%] space-y-1",
              message.role === "user" ? "items-end" : "items-start"
            )}
          >
            <div
              class={cn(
                "px-4 py-2.5 rounded-2xl text-sm",
                message.role === "user"
                  ? "bg-indigo-600 text-white rounded-br-md"
                  : "bg-zinc-800 text-zinc-100 rounded-bl-md"
              )}
            >
              {message.content}
            </div>

            <!-- Metadata -->
            {#if message.metadata && message.role === "assistant"}
              <div class="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span>{formatTime(message.timestamp)}</span>
                {#if message.metadata.provider}
                  <span class="px-1.5 py-0.5 bg-zinc-800 rounded-sm text-zinc-400">
                    {message.metadata.provider}/{message.metadata.model}
                  </span>
                {/if}
                {#if message.metadata.tokensOut}
                  <span
                    >{message.metadata.tokensIn}{t("chatInterface.tokens", {
                      tokensOut: message.metadata.tokensOut,
                    })}</span
                  >
                {/if}
                {#if message.metadata.durationMs}
                  <span>{(message.metadata.durationMs / 1000).toFixed(2)}s</span>
                {/if}
                {#if message.metadata.cached}
                  <span
                    class="flex items-center gap-1 text-amber-400"
                    title={t("chatInterface.responseFromCache")}
                  >
                    <Sparkles size={10} />
                    {t("chatInterface.cached")}
                  </span>
                {/if}
              </div>
            {:else}
              <div class="text-xs text-zinc-600">
                {formatTime(message.timestamp)}
              </div>
            {/if}

            <!-- Tool calls -->
            {#if message.toolCalls && message.toolCalls.length > 0}
              <div class="mt-2 space-y-1.5">
                {#each message.toolCalls as tool}
                  <div class="text-xs bg-zinc-900/80 border border-zinc-800 rounded-lg p-2">
                    <div class="flex items-center gap-1.5 text-indigo-400 mb-1">
                      <Wrench size={12} />
                      <span class="font-medium">{tool.name}</span>
                    </div>
                    <div class="text-zinc-500 font-mono truncate">
                      {JSON.stringify(tool.arguments)}
                    </div>
                    <div class="mt-1 text-zinc-400 line-clamp-3">
                      {tool.result}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/each}

      {#if loading}
        <div class="flex gap-3">
          <div class="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
            <Bot size={16} class="text-indigo-400" />
          </div>
          <div class="px-4 py-2.5 bg-zinc-800 rounded-2xl rounded-bl-md">
            <div class="flex gap-1">
              <span class="w-2 h-2 bg-zinc-500 rounded-full animate-bounce"></span>
              <span
                class="w-2 h-2 bg-zinc-500 rounded-full animate-bounce"
                style="animation-delay: 0.1s"
              ></span>
              <span
                class="w-2 h-2 bg-zinc-500 rounded-full animate-bounce"
                style="animation-delay: 0.2s"
              ></span>
            </div>
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Input -->
  <form onsubmit={handleSubmit} class="p-4 border-t border-zinc-800 bg-zinc-900/80">
    <div class="flex gap-2">
      <input
        type="text"
        bind:value={inputValue}
        placeholder={t("chatInterface.writesAMessage")}
        disabled={loading}
        class="flex-1 px-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 disabled:opacity-50"
      />
      <Button
        type="submit"
        variant="primary"
        size="md"
        {loading}
        disabled={!inputValue.trim() || loading}
      >
        <Send size={16} />
      </Button>
    </div>
  </form>
</div>
