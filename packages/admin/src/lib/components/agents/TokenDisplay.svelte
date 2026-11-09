<!--
  Token Display Component
  Shows an agent token securely
  The token is shown only once (one-way)
-->
<script lang="ts">
  import { t as tr } from "$lib/i18n";
  import { Copy, Check, Eye, EyeOff, AlertTriangle } from "lucide-svelte";

  import Button from "$lib/components/ui/Button.svelte";
  import Modal from "$lib/components/ui/Modal.svelte";
  import { cn } from "$lib/utils";

  interface Props {
    token?: string;
    tokenPrefix?: string;
    onCopy?: () => void;
  }

  const { token, tokenPrefix = "kitsuden_agent_", onCopy }: Props = $props();

  let showToken = $state(false);
  let copied = $state(false);
  let dismissed = $state(false);

  function copyToClipboard() {
    if (token) {
      navigator.clipboard.writeText(token);
      copied = true;
      onCopy?.();
      setTimeout(() => (copied = false), 2000);
    }
  }

  function maskToken(t: string): string {
    if (t.length <= 12) return "•".repeat(t.length);
    return t.slice(0, 8) + "•".repeat(t.length - 12) + t.slice(-4);
  }

  const displayToken = $derived(token || `${tokenPrefix}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
  const isRevealed = $derived(showToken && !!token);
</script>

{#if token && !dismissed}
  <Modal
    open={true}
    title={tr("tokenDisplay.generatedAgentToken")}
    description={tr("tokenDisplay.thisTokenWillOnlyBeShown")}
    size="lg"
    onClose={() => (dismissed = true)}
  >
    <div class="space-y-4">
      <!-- Warning -->
      <div class="flex items-start gap-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
        <AlertTriangle class="text-amber-400 shrink-0 mt-0.5" size={18} />
        <div class="text-sm text-amber-200">
          <p class="font-medium">{tr("tokenDisplay.important")}</p>
          <p class="mt-1">
            {tr("tokenDisplay.theTokenIsStoredAs")}
          </p>
        </div>
      </div>

      <!-- Token Display -->
      <div class="relative">
        <div
          class="flex items-center gap-2 p-4 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm"
        >
          <button
            class="p-1 hover:bg-zinc-800 rounded-sm transition-colors"
            onclick={() => (showToken = !showToken)}
          >
            {#if showToken}
              <EyeOff size={16} class="text-zinc-500" />
            {:else}
              <Eye size={16} class="text-zinc-500" />
            {/if}
          </button>

          <span class={cn("flex-1", !showToken && "tracking-wider")}>
            {showToken ? displayToken : maskToken(displayToken)}
          </span>

          <Button variant="ghost" size="sm" onclick={copyToClipboard}>
            {#if copied}
              <Check size={16} class="text-emerald-400" />
            {:else}
              <Copy size={16} />
            {/if}
          </Button>
        </div>
      </div>

      <!-- Usage Example -->
      <div class="p-3 bg-zinc-950 rounded-lg">
        <span class="text-xs font-medium text-zinc-500 uppercase"
          >{tr("tokenDisplay.apiUsage")}</span
        >
        <pre class="mt-2 text-xs text-zinc-400 overflow-x-auto">
Authorization: Bearer {showToken ? displayToken : maskToken(displayToken)}</pre>
      </div>
    </div>

    {#snippet footer()}
      <div class="flex justify-end gap-3">
        <Button variant="secondary" onclick={copyToClipboard}>
          {copied ? tr("tokenDisplay.copied") : tr("tokenDisplay.copyToken")}
        </Button>
        <Button variant="primary" onclick={() => (dismissed = true)}
          >{tr("tokenDisplay.gotItClose")}</Button
        >
      </div>
    {/snippet}
  </Modal>
{/if}

<!-- Compact display (when token is already saved) -->
{#if !token}
  <div class="flex items-center gap-2 text-sm text-zinc-500">
    <EyeOff size={14} />
    <span>{tr("tokenDisplay.tokenHiddenForSecurity")}</span>
  </div>
{/if}
