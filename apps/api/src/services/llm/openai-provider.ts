/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OpenAI Provider Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 */

// The SDK is imported the first time it is used: it is an
// OPTIONAL dependency of the published package; without it, only this provider fails.
import type OpenAI from "openai";

import type {
  EmbeddingOptions,
  LLMProviderAdapter,
  LLMProviderName,
  LLMRequestOptions,
  LLMResponse,
} from "./types";

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenAIProvider implements LLMProviderAdapter {
  readonly name: LLMProviderName = "openai";
  /** The configured model (OPENAI_MODEL or the call's config), which the engine sends with each request. */
  readonly defaultModel: string;

  private clientPromise: Promise<OpenAI> | null = null;
  private readonly options: ConstructorParameters<typeof OpenAI>[0];
  private model: string;

  constructor(config: OpenAIProviderConfig = {}) {
    this.model = this.defaultModel = config.defaultModel || "gpt-4o-mini";
    this.options = { apiKey: config.apiKey, baseURL: config.baseUrl };
  }

  private client(): Promise<OpenAI> {
    this.clientPromise ??= import("openai").then((m) => new m.default(this.options));
    return this.clientPromise;
  }

  isConfigured(): boolean {
    return !!(this.options?.apiKey ?? process.env.OPENAI_API_KEY);
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const model = options.model || this.model;
    const timeoutMs = options.timeoutMs ?? 60000;

    const messages = this.buildMessages(options);

    const abortController = new AbortController();
    const externalSignal = options.signal;
    const externalAbortHandler = () => abortController.abort();
    externalSignal?.addEventListener("abort", externalAbortHandler, { once: true });

    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`OpenAI request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const response = await (
        await this.client()
      ).chat.completions.create(
        {
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens,
          top_p: options.topP,
          tools: options.tools?.map((t) => ({
            type: "function",
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters as unknown as Record<string, unknown>,
            },
          })),
        },
        { signal: abortController.signal }
      );

      const choice = response.choices[0];
      const message = choice?.message;

      return {
        content: message?.content || "",
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
        model: response.model,
        provider: this.name,
        finishReason: choice?.finish_reason || null,
        toolCalls: message?.tool_calls
          ?.filter((tc) => tc.type === "function")
          .map((tc) => {
            const toolCall = tc as OpenAI.Chat.ChatCompletionMessageFunctionToolCall;
            return {
              id: toolCall.id,
              type: "function" as const,
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              },
            };
          }),
      };
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", externalAbortHandler);
    }
  }

  async completeStream(
    options: LLMRequestOptions,
    onText: (delta: string) => void
  ): Promise<LLMResponse> {
    const model = options.model || this.model;
    const timeoutMs = options.timeoutMs ?? 60000;
    const abortController = new AbortController();
    const externalSignal = options.signal;
    const externalAbortHandler = () => abortController.abort();
    externalSignal?.addEventListener("abort", externalAbortHandler, { once: true });
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`OpenAI request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const stream = await (
        await this.client()
      ).chat.completions.create(
        {
          model,
          messages: this.buildMessages(options),
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens,
          top_p: options.topP,
          tools: options.tools?.map((t) => ({
            type: "function",
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters as unknown as Record<string, unknown>,
            },
          })),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: abortController.signal }
      );

      let content = "";
      let finishReason: string | null = null;
      let modelName = model;
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      // Tool calls arrive in pieces, keyed by their index in the message.
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        modelName = chunk.model || modelName;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens || 0,
            completionTokens: chunk.usage.completion_tokens || 0,
            totalTokens: chunk.usage.total_tokens || 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          content += delta.content;
          onText(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const call = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.arguments += tc.function.arguments;
          calls.set(tc.index, call);
        }
      }

      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      return {
        content,
        usage,
        model: modelName,
        provider: this.name,
        finishReason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", externalAbortHandler);
    }
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const model = options?.model || "text-embedding-3-small";
    const response = await (
      await this.client()
    ).embeddings.create({
      model,
      input: text,
      dimensions: options?.dimensions,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new Error("OpenAI returned empty embedding");
    }
    return embedding;
  }

  private buildMessages(options: LLMRequestOptions): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (options.system) {
      messages.push({ role: "system", content: options.system });
    }

    for (const msg of options.messages) {
      if (msg.role === "tool") {
        messages.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId || "",
        });
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    return messages;
  }
}
