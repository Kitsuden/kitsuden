/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DeepSeek Provider Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DeepSeek exposes an OpenAI-compatible API. We reuse the OpenAI
 * client pointing at DeepSeek's base URL.
 */

import { OpenAIProvider } from "./openai-provider";
import type { LLMProviderName } from "./types";

export interface DeepSeekProviderConfig {
  apiKey?: string;
  defaultModel?: string;
}

export class DeepSeekProvider extends OpenAIProvider {
  readonly name: LLMProviderName = "deepseek";
  constructor(config: DeepSeekProviderConfig = {}) {
    super({
      apiKey: config.apiKey,
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: config.defaultModel || "deepseek-chat",
    });
  }
}
