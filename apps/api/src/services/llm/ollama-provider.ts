/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Ollama Provider Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * For running models locally. Supports chat completions and embeddings.
 */

// The SDK is imported the first time it is used: it is an
// OPTIONAL dependency of the published package; without it, only this provider fails.
import type { Ollama } from "ollama";

import type {
  EmbeddingOptions,
  LLMMessage,
  LLMProviderAdapter,
  LLMProviderName,
  LLMRequestOptions,
  LLMResponse,
} from "./types";

export interface OllamaProviderConfig {
  baseUrl?: string;
  defaultModel?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    // Clear the timeout if the original promise wins, to avoid leaks
    promise.then(() => clearTimeout(id)).catch(() => clearTimeout(id));
  });
  return Promise.race([promise, timeoutPromise]);
}

export class OllamaProvider implements LLMProviderAdapter {
  readonly name: LLMProviderName = "ollama";
  /** The configured model, which the engine sends with each request. */
  readonly defaultModel: string;

  private clientPromise: Promise<Ollama> | null = null;
  private readonly host: string;
  private model: string;

  constructor(config: OllamaProviderConfig = {}) {
    this.model = this.defaultModel = config.defaultModel || "llama3.2";
    this.host = config.baseUrl || "http://localhost:11434";
  }

  private client(): Promise<Ollama> {
    this.clientPromise ??= import("ollama").then((m) => new m.Ollama({ host: this.host }));
    return this.clientPromise;
  }

  isConfigured(): boolean {
    // Ollama needs no API key, just a reachable URL.
    return true;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const model = options.model || this.model;
    const timeoutMs = options.timeoutMs ?? 120000;

    const messages = this.buildMessages(options);

    const chatPromise = (await this.client()).chat({
      model,
      messages: messages.map((m) => ({
        role: m.role === "tool" ? "assistant" : m.role,
        content: m.content,
      })),
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens,
        top_p: options.topP,
      },
    });

    const response = await withTimeout(
      chatPromise,
      timeoutMs,
      `Ollama request timed out after ${timeoutMs}ms`
    );

    return {
      content: response.message.content || "",
      usage: {
        promptTokens: response.prompt_eval_count || 0,
        completionTokens: response.eval_count || 0,
        totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      },
      model,
      provider: this.name,
      finishReason: response.done ? "stop" : null,
    };
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const model = options?.model || "nomic-embed-text";
    const response = await (
      await this.client()
    ).embeddings({
      model,
      prompt: text,
    });

    if (!response.embedding) {
      throw new Error("Ollama returned empty embedding");
    }
    return response.embedding;
  }

  private buildMessages(options: LLMRequestOptions): LLMMessage[] {
    const messages: LLMMessage[] = [];

    if (options.system) {
      messages.push({ role: "system", content: options.system });
    }

    for (const msg of options.messages) {
      messages.push(msg);
    }

    return messages;
  }
}
