/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LLM Provider Types — Kitsuden Agents Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unified contract for LLM adapters. Any provider
 * (OpenAI, Anthropic, Ollama, DeepSeek) must implement LLMProviderAdapter.
 */

export type LLMProviderName = "openai" | "anthropic" | "deepseek" | "ollama";

export type LLMMessageRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  /**
   * An assistant turn exactly as the provider returned it (`LLMResponse.providerContent`). A provider that
   * needs it back unchanged (Anthropic: thinking blocks before a tool call) sends it instead of `content`.
   */
  providerContent?: unknown;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface LLMToolParameter {
  type?: string;
  description?: string;
  enum?: (string | number | boolean)[];
  properties?: Record<string, LLMToolParameter>;
  required?: string[];
  items?: LLMToolParameter;
  default?: unknown;
  [key: string]: unknown;
}

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: LLMToolParameter;
  };
}

export interface LLMRequestOptions {
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: LLMTool[];
  system?: string;
  /**
   * Timeout in milliseconds. If not provided, a provider default is used.
   */
  timeoutMs?: number;
  /**
   * External AbortSignal to cancel the request.
   */
  signal?: AbortSignal;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string;
  usage: LLMUsage;
  model: string;
  provider: LLMProviderName;
  finishReason: string | null;
  /** The assistant turn in the provider's own shape, to send back as `LLMMessage.providerContent`. */
  providerContent?: unknown;
  /**
   * If the LLM asked to call tools, they are returned here.
   * The Agent Engine runs them and calls the provider again.
   */
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
}

export interface LLMProviderAdapter {
  readonly name: LLMProviderName;
  readonly defaultModel: string;

  /**
   * Sends a completion to the LLM and returns the response.
   */
  complete(options: LLMRequestOptions): Promise<LLMResponse>;

  /**
   * Generates an embedding for the given text.
   * If the provider does not support embeddings, it must throw an error.
   */
  embed(text: string, options?: EmbeddingOptions): Promise<number[]>;

  /**
   * The same completion, handing over its text as it is written (`onText` with each piece), and returning the
   * whole response at the end, tool calls included. Optional: without it, the engine calls `complete` and hands
   * the text over in one piece.
   */
  completeStream?(
    options: LLMRequestOptions,
    onText: (delta: string) => void
  ): Promise<LLMResponse>;

  /**
   * Checks whether the adapter is correctly configured (has an API key, URL, etc.)
   */
  isConfigured(): boolean;
}

export interface LLMConfig {
  provider: LLMProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}
