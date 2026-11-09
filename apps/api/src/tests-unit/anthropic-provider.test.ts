/**
 * The Anthropic provider — no network
 * ============================================================================
 *
 * services/llm/anthropic-provider.ts: the request body the engine's conversation becomes (model, no sampling
 * parameters, room for thinking, tool calls and results in the Messages API shape), and a tool round trip with
 * a fake client, where the assistant turn must come back unchanged with its thinking block.
 */

import { describe, expect, it } from "bun:test";

import {
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  REFUSAL_NOTICE,
  toAnthropicMessages,
  toResponse,
} from "../services/llm/anthropic-provider";
import type { LLMMessage } from "../services/llm/types";

const tool = {
  type: "function" as const,
  function: {
    name: "crm__list-deals",
    description: "List deals",
    parameters: { type: "object", properties: {} },
  },
};

describe("the request body", () => {
  it("uses the configured model, or the current default", () => {
    expect(new AnthropicProvider().defaultModel).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(ANTHROPIC_DEFAULT_MODEL).toBe("claude-opus-5-5");
    const configured = new AnthropicProvider({ defaultModel: "claude-sonnet-5-5" });
    expect(configured.defaultModel).toBe("claude-sonnet-5-5");
    expect(configured.buildRequest({ messages: [{ role: "user", content: "hi" }] }).model).toBe(
      "claude-sonnet-5-5"
    );
    expect(
      configured.buildRequest({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "hi" }],
      }).model
    ).toBe("claude-haiku-5-5");
  });

  it("never sends temperature or top_p, and leaves room for thinking", () => {
    const body = new AnthropicProvider().buildRequest({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
    });
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    expect(body.max_tokens).toBe(16_000);
    expect(
      new AnthropicProvider().buildRequest({ messages: [], maxTokens: 64_000 }).max_tokens
    ).toBe(64_000);
  });

  it("joins system messages into the system field and sends no empty tools list", () => {
    const body = new AnthropicProvider().buildRequest({
      system: "You are the CRM assistant.",
      messages: [
        { role: "system", content: "Answer in Spanish." },
        { role: "user", content: "hello" },
      ],
      tools: [],
    });
    expect(body.system).toBe("You are the CRM assistant.\n\nAnswer in Spanish.");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect("tools" in body).toBe(false);
  });
});

describe("tool calls and results", () => {
  it("turns OpenAI-shaped tool turns into tool_use and one user message of tool_result", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "How many open deals?" },
      {
        role: "assistant",
        content: "Let me look.",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "crm__list-deals", arguments: '{"status":"open"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "crm__count-deals", arguments: "not json" },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: '{"data":[]}' },
      {
        role: "tool",
        toolCallId: "call_2",
        content: "Error executing tool crm__count-deals: boom",
      },
    ];
    const { messages: out } = toAnthropicMessages({ messages });
    expect(out).toEqual([
      { role: "user", content: "How many open deals?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "call_1", name: "crm__list-deals", input: { status: "open" } },
          { type: "tool_use", id: "call_2", name: "crm__count-deals", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"data":[]}' },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: "Error executing tool crm__count-deals: boom",
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("a tool result with no text still has content", () => {
    const { messages } = toAnthropicMessages({
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }],
        },
        { role: "tool", toolCallId: "c", content: "" },
      ],
    });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c", name: "t", input: {} }],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c", content: "(empty result)" }],
    });
  });

  it("sends back the assistant turn it returned, thinking block included and unchanged", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const toolUse = {
      type: "tool_use",
      id: "toolu_1",
      name: "crm__list-deals",
      input: { status: "open" },
    };
    const sent: Record<string, unknown>[] = [];
    const fake = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          sent.push(body);
          return sent.length === 1
            ? {
                content: [thinking, toolUse],
                model: "claude-opus-5-5",
                stop_reason: "tool_use",
                usage: { input_tokens: 10, output_tokens: 5 },
              }
            : {
                content: [{ type: "text", text: "There are none.", citations: null }],
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                usage: { input_tokens: 20, output_tokens: 4 },
              };
        },
      },
    };
    const provider = new AnthropicProvider({ apiKey: "test", fallbacks: false });
    (provider as unknown as { clientPromise: Promise<unknown> }).clientPromise =
      Promise.resolve(fake);

    const messages: LLMMessage[] = [{ role: "user", content: "Open deals?" }];
    const first = await provider.complete({
      messages,
      tools: [tool],
      temperature: 0.7,
      maxTokens: 2048,
    });
    expect(first.toolCalls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "crm__list-deals", arguments: '{"status":"open"}' },
      },
    ]);
    expect(first.providerContent).toEqual([thinking, toolUse]);

    // What the engine does between the two calls.
    messages.push({
      role: "assistant",
      content: first.content,
      providerContent: first.providerContent,
      toolCalls: first.toolCalls,
    });
    messages.push({ role: "tool", toolCallId: "toolu_1", content: '{"data":[]}' });
    const second = await provider.complete({
      messages,
      tools: [tool],
      temperature: 0.7,
      maxTokens: 2048,
    });
    expect(second.content).toBe("There are none.");
    expect(second.usage.totalTokens).toBe(24);

    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect("temperature" in body).toBe(false);
      expect(body.model).toBe("claude-opus-5-5");
    }
    expect(sent[1].messages).toEqual([
      { role: "user", content: "Open deals?" },
      { role: "assistant", content: [thinking, toolUse] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"data":[]}' }],
      },
    ]);
  });
});

describe("refusals", () => {
  const usage = { input_tokens: 10, output_tokens: 5 };

  it("opts into server-side fallback on the models that take it, and only there", () => {
    const body = new AnthropicProvider().buildRequest({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    const haiku = new AnthropicProvider({ defaultModel: "claude-haiku-5-5" }).buildRequest({
      messages: [],
    });
    expect("fallbacks" in haiku).toBe(false);
    const off = new AnthropicProvider({ fallbacks: false }).buildRequest({ messages: [] });
    expect("fallbacks" in off).toBe(false);
    expect("betas" in off).toBe(false);
  });

  it("sends fallback requests through the beta endpoint", async () => {
    const sent: Record<string, unknown>[] = [];
    const fake = {
      messages: {
        create: async () => Promise.reject(new Error("the plain endpoint must not be used")),
      },
      beta: {
        messages: {
          create: async (body: Record<string, unknown>) => {
            sent.push(body);
            return {
              content: [{ type: "text", text: "ok" }],
              model: "claude-opus-5-5",
              stop_reason: "end_turn",
              usage,
            };
          },
        },
      },
    };
    const provider = new AnthropicProvider({ apiKey: "test" });
    (provider as unknown as { clientPromise: Promise<unknown> }).clientPromise =
      Promise.resolve(fake);
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toBe("ok");
    expect(sent[0].fallbacks).toBe("default");
    expect(sent[0].betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("a refusal by the whole chain is a notice, not an empty or partial answer", () => {
    const res = toResponse({
      content: [{ type: "text", text: "Sure, here is how to" }],
      model: "claude-opus-5-5",
      stop_reason: "refusal",
      usage,
    });
    expect(res.content).toBe(REFUSAL_NOTICE);
    expect(res.finishReason).toBe("refusal");
    expect(res.toolCalls).toBeUndefined();
    expect(res.providerContent).toBeUndefined();
  });

  it("after a mid-output fallback, only text from before the switch is kept", () => {
    const res = toResponse({
      content: [
        { type: "thinking", thinking: "", signature: "a" },
        { type: "text", text: "Looking at" },
        { type: "tool_use", id: "t0", name: "never_run", input: {} },
        { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
        { type: "thinking", thinking: "", signature: "b" },
        { type: "text", text: "your deals." },
        { type: "tool_use", id: "t1", name: "crm__list-deals", input: {} },
      ],
      model: "claude-opus-5",
      stop_reason: "tool_use",
      usage,
    });
    expect(res.content).toBe("Looking at\nyour deals.");
    expect(res.toolCalls?.map((c) => c.id)).toEqual(["t1"]);
    expect((res.providerContent as Array<{ type: string }>).map((b) => b.type)).toEqual([
      "text",
      "fallback",
      "thinking",
      "text",
      "tool_use",
    ]);
  });
});
