/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Anthropic Provider Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Translates the engine's OpenAI-shaped conversation into the Messages API:
 * - `system` messages go to the top-level `system` field;
 * - an assistant turn with tool calls becomes `tool_use` blocks, and the `tool` messages after it become one
 *   user message of `tool_result` blocks (one per call, in order);
 * - an assistant turn this provider returned travels back exactly as it came (`providerContent`), because
 *   current models think before calling a tool and those thinking blocks must be sent back unchanged.
 *
 * Sampling parameters (`temperature`, `top_p`) are never sent: current Claude models reject them, and from
 * API version 2026-10-21 every model does. Thinking is left to the model (adaptive by default on current
 * models), so `max_tokens` has room for it.
 *
 * Refusals: on the models that support it, requests opt into server-side fallback (`fallbacks: "default"`):
 * when the model's safety classifiers decline, the API answers with the model Anthropic recommends for that
 * kind of decline, in the same call. If the whole chain declines, the answer is a short notice with
 * `finishReason: "refusal"` instead of an empty text. `ANTHROPIC_FALLBACKS=off` turns the opt-in off.
 */

// The SDK is imported the first time it is used: it is an
// OPTIONAL dependency of the published package; without it, only this provider fails.
import type Anthropic from "@anthropic-ai/sdk";

import type {
  EmbeddingOptions,
  LLMMessage,
  LLMProviderAdapter,
  LLMProviderName,
  LLMRequestOptions,
  LLMResponse,
} from "./types";

export interface AnthropicProviderConfig {
  apiKey?: string;
  defaultModel?: string;
  /** Server-side refusal fallback on the models that support it. Default: on, unless ANTHROPIC_FALLBACKS=off. */
  fallbacks?: boolean;
}

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Thinking shares `max_tokens` with the answer, so a budget sized for the answer alone (the engine asks for
 * 2048) would cut the turn short. Below this floor, the floor wins.
 */
const MIN_MAX_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 180_000;

/** Models that accept `fallbacks: "default"` on the Claude API. Claude Haiku 5.5 has no server-side fallback. */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const REFUSAL_NOTICE = "The model declined to answer this request.";

type RequestBody = Anthropic.Messages.MessageCreateParamsNonStreaming & {
  betas?: string[];
  fallbacks?: "default";
};

/** The parts of a Message (or a beta Message) this provider reads. */
interface AnyMessage {
  content: unknown[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements LLMProviderAdapter {
  readonly name: LLMProviderName = "anthropic";
  /** The configured model (ANTHROPIC_MODEL or the call's config), which the engine sends with each request. */
  readonly defaultModel: string;

  private clientPromise: Promise<Anthropic> | null = null;
  private readonly options: ConstructorParameters<typeof Anthropic>[0];
  private readonly fallbacks: boolean;

  constructor(config: AnthropicProviderConfig = {}) {
    this.defaultModel = config.defaultModel || ANTHROPIC_DEFAULT_MODEL;
    this.options = { apiKey: config.apiKey };
    // Only the Claude API itself takes the field; a proxy or another platform behind ANTHROPIC_BASE_URL may not.
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const firstParty = !baseUrl || /^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl);
    this.fallbacks = config.fallbacks ?? (firstParty && process.env.ANTHROPIC_FALLBACKS !== "off");
  }

  private client(): Promise<Anthropic> {
    this.clientPromise ??= import("@anthropic-ai/sdk").then((m) => new m.default(this.options));
    return this.clientPromise;
  }

  isConfigured(): boolean {
    return !!(this.options?.apiKey ?? process.env.ANTHROPIC_API_KEY);
  }

  /** The request body. Public so it is tested without a network. */
  buildRequest(options: LLMRequestOptions): RequestBody {
    const { system, messages } = toAnthropicMessages(options);
    const model = options.model || this.defaultModel;
    return {
      model,
      ...(this.fallbacks && FALLBACK_MODELS.has(model)
        ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
        : {}),
      max_tokens: Math.max(options.maxTokens ?? 0, MIN_MAX_TOKENS),
      ...(system ? { system } : {}),
      messages,
      ...(options.tools?.length
        ? {
            tools: options.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters as Anthropic.Messages.Tool.InputSchema,
            })),
          }
        : {}),
    };
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const body = this.buildRequest(options);
    return this.withTimeout(options, async (signal) => {
      const client = await this.client();
      // The installed SDK types `fallbacks` only as a list; the API also takes "default" (with its own beta).
      const message: AnyMessage = body.fallbacks
        ? await client.beta.messages.create(
            body as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
            {
              signal,
            }
          )
        : await client.messages.create(body, { signal });
      return toResponse(message);
    });
  }

  async completeStream(
    options: LLMRequestOptions,
    onText: (delta: string) => void
  ): Promise<LLMResponse> {
    const body = this.buildRequest(options);
    return this.withTimeout(options, async (signal) => {
      const client = await this.client();
      if (body.fallbacks) {
        const stream = client.beta.messages.stream(
          body as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
          { signal }
        );
        stream.on("text", (delta) => onText(delta));
        return toResponse(await stream.finalMessage());
      }
      const stream = client.messages.stream(body, { signal });
      stream.on("text", (delta) => onText(delta));
      return toResponse(await stream.finalMessage());
    });
  }

  private async withTimeout<T>(
    options: LLMRequestOptions,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abortController = new AbortController();
    const externalSignal = options.signal;
    const externalAbortHandler = () => abortController.abort();
    externalSignal?.addEventListener("abort", externalAbortHandler, { once: true });
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Anthropic request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      return await run(abortController.signal);
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", externalAbortHandler);
    }
  }

  // Anthropic does not provide native embeddings. We throw a controlled error.
  async embed(_text: string, _options?: EmbeddingOptions): Promise<number[]> {
    throw new Error("Anthropic does not provide embeddings. Use OpenAI or Ollama for embeddings.");
  }
}

/** The engine's conversation as Messages API `system` + `messages`. */
export function toAnthropicMessages(options: Pick<LLMRequestOptions, "system" | "messages">): {
  system: string | null;
  messages: Anthropic.Messages.MessageParam[];
} {
  let system = options.system || null;
  const messages: Anthropic.Messages.MessageParam[] = [];
  let pendingResults: Anthropic.Messages.ToolResultBlockParam[] = [];

  const flushResults = () => {
    if (pendingResults.length === 0) return;
    // All the results of one turn go in a single user message, in the order of the calls.
    messages.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const msg of options.messages) {
    if (msg.role === "system") {
      system = system ? `${system}\n\n${msg.content}` : msg.content;
      continue;
    }
    if (msg.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: msg.content || "(empty result)",
        ...(isErrorResult(msg) ? { is_error: true } : {}),
      });
      continue;
    }
    flushResults();
    if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: assistantContent(msg) });
    } else {
      messages.push({ role: "user", content: msg.content });
    }
  }
  flushResults();
  return { system, messages };
}

function assistantContent(msg: LLMMessage): string | Anthropic.Messages.ContentBlockParam[] {
  // A turn this provider returned goes back exactly as it came: thinking blocks included and unchanged.
  if (Array.isArray(msg.providerContent))
    return msg.providerContent as Anthropic.Messages.ContentBlockParam[];
  if (!msg.toolCalls?.length) return msg.content;
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const call of msg.toolCalls) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseInput(call.function.arguments),
    });
  }
  return blocks;
}

function parseInput(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The engine marks failed tool results in their text; the API wants them flagged. */
function isErrorResult(msg: LLMMessage): boolean {
  return /^Error (executing|parsing arguments for) tool /.test(msg.content);
}

/** Model-internal blocks written before a fallback: the model that continued did not write them, so they are not sent back. */
const NOT_ECHOED_BEFORE_FALLBACK = new Set([
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
]);

/** A Messages API response as the engine's `LLMResponse`. Exported for tests. */
export function toResponse(response: AnyMessage): LLMResponse {
  const blocks = response.content as Array<{ type: string } & Record<string, unknown>>;
  let boundary = -1;
  blocks.forEach((b, i) => {
    if (b.type === "fallback") boundary = i;
  });
  // Before the last switch only text carries over; tool calls there were never made.
  const kept = blocks.filter((b, i) => i > boundary || !NOT_ECHOED_BEFORE_FALLBACK.has(b.type));
  const usage = {
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
  };
  if (response.stop_reason === "refusal") {
    // Declined by every model in the chain: what was written before the decline is not an answer.
    return {
      content: REFUSAL_NOTICE,
      usage,
      model: response.model,
      provider: "anthropic",
      finishReason: "refusal",
    };
  }
  const content = kept
    .filter((c) => c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n");
  const toolCalls = kept
    .filter((c) => c.type === "tool_use")
    .map((tool) => ({
      id: String(tool.id),
      type: "function" as const,
      function: { name: String(tool.name), arguments: JSON.stringify(tool.input ?? {}) },
    }));
  return {
    content,
    usage,
    model: response.model,
    provider: "anthropic",
    finishReason: response.stop_reason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    providerContent: kept,
  };
}
