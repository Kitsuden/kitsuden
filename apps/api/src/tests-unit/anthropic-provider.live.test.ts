/**
 * The Anthropic provider against the real API — skipped unless asked for
 * ============================================================================
 *
 * Spends real money (a few cents: three short requests and one tool round trip on the provider's default
 * model). Runs only with an API key AND `ANTHROPIC_LIVE=yes`, so a key in CI never runs it by accident:
 *
 *   ANTHROPIC_LIVE=yes ANTHROPIC_API_KEY=... bun test src/tests-unit/anthropic-provider.live.test.ts
 *
 * It checks what the offline tests cannot: that the API accepts the body (no sampling parameters, the
 * fallback opt-in, the tool_use/tool_result shape) and that thinking blocks sent back are accepted.
 */

import { describe, expect, it } from "bun:test";

import { AnthropicProvider } from "../services/llm/anthropic-provider";
import type { LLMMessage } from "../services/llm/types";

const live = process.env.ANTHROPIC_LIVE === "yes" && Boolean(process.env.ANTHROPIC_API_KEY);
const TIMEOUT = 180_000;

const weather = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Current weather in a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe.skipIf(!live)("Anthropic, live", () => {
  const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });

  it(
    "answers a plain request (temperature from the engine is dropped)",
    async () => {
      const res = await provider.complete({
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        temperature: 0.7,
        maxTokens: 2048,
      });
      expect(res.finishReason).toBe("end_turn");
      expect(res.content.toLowerCase()).toContain("pong");
    },
    TIMEOUT
  );

  it(
    "streams text",
    async () => {
      const deltas: string[] = [];
      const res = await provider.completeStream(
        { messages: [{ role: "user", content: "Count from 1 to 5, separated by spaces." }] },
        (d) => deltas.push(d)
      );
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("")).toBe(res.content);
    },
    TIMEOUT
  );

  it(
    "completes a tool round trip, sending the assistant turn back unchanged",
    async () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "What is the weather in Lima? Use the tool." },
      ];
      const first = await provider.complete({ messages, tools: [weather] });
      expect(first.toolCalls?.[0]?.function.name).toBe("get_weather");
      const call = first.toolCalls![0];
      messages.push({
        role: "assistant",
        content: first.content,
        providerContent: first.providerContent,
        toolCalls: first.toolCalls,
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: '{"city":"Lima","tempC":19,"sky":"overcast"}',
      });
      const second = await provider.complete({ messages, tools: [weather] });
      expect(second.finishReason).toBe("end_turn");
      expect(second.content).toContain("19");
    },
    TIMEOUT
  );
});
