/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LLM Provider Factory — Kitsuden Agents Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unified entry point to create LLM adapters according to configuration.
 */

import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider } from "./anthropic-provider";
import { DeepSeekProvider } from "./deepseek-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenAIProvider } from "./openai-provider";
import type { LLMConfig, LLMProviderAdapter, LLMProviderName } from "./types";

export * from "./types";
export { OpenAIProvider } from "./openai-provider";
export { AnthropicProvider } from "./anthropic-provider";
export { OllamaProvider } from "./ollama-provider";
export { DeepSeekProvider } from "./deepseek-provider";

/**
 * Creates an LLM adapter from a configuration.
 */
export function createLLMProvider(config: LLMConfig): LLMProviderAdapter {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.model,
      });
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.apiKey,
        defaultModel: config.model,
      });
    case "deepseek":
      return new DeepSeekProvider({
        apiKey: config.apiKey,
        defaultModel: config.model,
      });
    case "ollama":
      return new OllamaProvider({
        baseUrl: config.baseUrl,
        defaultModel: config.model,
      });
    default:
      throw new Error(`Unsupported LLM provider: ${(config as LLMConfig).provider}`);
  }
}

/**
 * Where a provider's requests go: its base URL as the adapter (or its SDK, which
 * also reads `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`) will use it. The prompt
 * guard (docs/agents/egress.md) decides by this host.
 */
export function providerBaseUrl(config: LLMConfig): string {
  switch (config.provider) {
    case "openai":
      return config.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    case "anthropic":
      return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "ollama":
      return config.baseUrl || "http://localhost:11434";
    default:
      return "";
  }
}

/**
 * List of available providers according to the configured environment variables.
 */
export function listAvailableProviders(): LLMProviderName[] {
  const providers: LLMProviderName[] = [];

  if (process.env.OPENAI_API_KEY) providers.push("openai");
  if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
  if (process.env.DEEPSEEK_API_KEY) providers.push("deepseek");
  // Ollama is in principle always available (it needs no key)
  providers.push("ollama");

  return providers;
}

/**
 * Returns the default provider according to configuration priority.
 * Priority: OPENAI > ANTHROPIC > DEEPSEEK > OLLAMA.
 */
export function getDefaultProviderConfig(): LLMConfig | null {
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      apiKey: process.env.DEEPSEEK_API_KEY,
    };
  }

  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    return {
      provider: "ollama",
      model: process.env.OLLAMA_MODEL || "llama3.2",
      baseUrl: process.env.OLLAMA_BASE_URL,
    };
  }

  return null;
}
