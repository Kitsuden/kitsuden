/**
 * LLM — semantic cache and structured output
 * ============================================================================
 * Everything in memory: no Valkey, no network, no API keys. Providers are
 * injected as deterministic fakes.
 */

import {
  SemanticCache,
  llmMemoryStore,
  extractJson,
  generateStructured,
  type LLMEmbeddingProvider,
  type StructuredProvider,
} from "@kitsuden/engine";
import { describe, expect, test, beforeEach } from "bun:test";
import { z } from "zod";

/**
 * Deterministic bag-of-words embeddings: two sentences with the same words
 * give identical vectors (similarity 1), and different sentences give low
 * similarity. Enough to test the cache logic without a network.
 */
const bagOfWords: LLMEmbeddingProvider = {
  async embed(text: string) {
    const vec = new Array(26).fill(0);
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      for (const ch of word) {
        const i = ch.charCodeAt(0) - 97;
        if (i >= 0 && i < 26) vec[i] += 1;
      }
    }
    return vec;
  },
};

const RESPONSE = {
  content: "A kon is created with kitsuden create-kon",
  model: "test",
  tokensIn: 120,
  tokensOut: 40,
};

describe("semantic cache", () => {
  let cache: SemanticCache;

  beforeEach(() => {
    cache = new SemanticCache({ store: llmMemoryStore(), embeddings: bagOfWords, threshold: 0.9 });
  });

  test("miss when empty", async () => {
    expect(await cache.lookup("agent-1", "how do I make a kon?")).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });

  test("EXACT hit with the same query", async () => {
    await cache.store_("agent-1", "how do I make a kon?", RESPONSE);
    const hit = await cache.lookup("agent-1", "how do I make a kon?");

    expect(hit).not.toBeNull();
    expect(hit!.hit).toBe("exact");
    expect(hit!.content).toBe(RESPONSE.content);
    expect(hit!.similarity).toBe(1);
  });

  test("SEMANTIC hit with the reworded query (what the exact cache misses)", async () => {
    await cache.store_("agent-1", "how do I make a kon", RESPONSE);

    // Same words, different order: the exact cache would fail.
    const hit = await cache.lookup("agent-1", "make a kon how do I");
    expect(hit).not.toBeNull();
    expect(hit!.hit).toBe("semantic");
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.9);
    expect(hit!.content).toBe(RESPONSE.content);
  });

  test("does NOT hit on a truly different query", async () => {
    await cache.store_("agent-1", "how do I make a kon", RESPONSE);
    expect(await cache.lookup("agent-1", "zzzz")).toBeNull();
  });

  test("scopes are ISOLATED (responses do not leak between tenants)", async () => {
    await cache.store_("tenant-a", "shared query", RESPONSE);

    expect(await cache.lookup("tenant-a", "shared query")).not.toBeNull();
    expect(await cache.lookup("tenant-b", "shared query")).toBeNull();
  });

  test("without an embeddings provider it degrades to an exact cache (does not throw)", async () => {
    const exact = new SemanticCache({ store: llmMemoryStore() });
    await exact.store_("a", "hello world", RESPONSE);

    expect((await exact.lookup("a", "hello world"))!.hit).toBe("exact");
    expect(await exact.lookup("a", "world hello")).toBeNull(); // no semantics
  });

  test("a broken store does NOT break the request", async () => {
    const broken = new SemanticCache({
      store: {
        async get() {
          throw new Error("Valkey down");
        },
        async set() {
          throw new Error("Valkey down");
        },
        async keys() {
          throw new Error("Valkey down");
        },
        async del() {
          throw new Error("Valkey down");
        },
      },
    });

    expect(await broken.lookup("a", "x")).toBeNull(); // miss, not an exception
    await broken.store_("a", "x", RESPONSE); // does not throw either
  });

  test("stats: hitRate and tokens saved", async () => {
    await cache.store_("a", "question one", RESPONSE);
    await cache.lookup("a", "question one"); // exact
    await cache.lookup("a", "zzzz"); // miss

    const stats = cache.getStats();
    expect(stats.exactHits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
    expect(stats.tokensSaved).toBe(RESPONSE.tokensIn);
  });

  test("invalidate clears the scope", async () => {
    await cache.store_("a", "one", RESPONSE);
    await cache.store_("a", "another", RESPONSE);

    const removed = await cache.invalidate("a");
    expect(removed).toBeGreaterThan(0);
    expect(await cache.lookup("a", "one")).toBeNull();
  });

  test("a high threshold avoids false positives (a wrong answer > the cost of another call)", async () => {
    const strict = new SemanticCache({
      store: llmMemoryStore(),
      embeddings: bagOfWords,
      threshold: 0.999,
    });
    await strict.store_("a", "abc def", RESPONSE);
    expect(await strict.lookup("a", "abc xyz")).toBeNull();
  });
});

describe("extractJson", () => {
  test("direct JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("inside a code block (the most common case)", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test("with prose around it", () => {
    expect(extractJson('Sure, here you go:\n{"a":1}\nI hope it helps.')).toEqual({ a: 1 });
  });

  test("respects braces inside strings", () => {
    expect(extractJson('{"text":"this has } inside"}')).toEqual({
      text: "this has } inside",
    });
  });

  test("arrays", () => {
    expect(extractJson("The result: [1,2,3]")).toEqual([1, 2, 3]);
  });

  test("throws if there is no JSON", () => {
    expect(() => extractJson("there is nothing here")).toThrow(/does not contain parseable JSON/);
  });
});

describe("generateStructured", () => {
  const Person = z.object({ name: z.string(), age: z.number().int().positive() });

  /** Fake provider that returns scripted responses, one per attempt. */
  function scripted(responses: string[], mode: "json_schema" | "prompt" = "json_schema") {
    let i = 0;
    const calls: any[] = [];
    const provider: StructuredProvider = {
      name: "fake",
      structuredMode: mode,
      async complete(req) {
        calls.push(req);
        return { text: responses[Math.min(i++, responses.length - 1)], tokensIn: 10, tokensOut: 5 };
      },
    };
    return { provider, calls };
  }

  test("succeeds on the first try", async () => {
    const { provider } = scripted(['{"name":"Ada","age":36}']);
    const r = await generateStructured(provider, {
      messages: [{ role: "user", content: "Extract the data" }],
      schema: Person,
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "Ada", age: 36 });
    expect(r.attempts).toBe(1);
  });

  test("RETRIES with the validation error and succeeds afterwards", async () => {
    const { provider, calls } = scripted([
      '{"name":"Ada","age":"thirty-six"}', // age is not a number
      '{"name":"Ada","age":36}',
    ]);

    const r = await generateStructured(provider, {
      messages: [{ role: "user", content: "Extract" }],
      schema: Person,
    });

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    // The model was told WHICH field failed — that is what raises the success rate.
    const followUp = calls[1].messages.map((m: any) => m.content).join("\n");
    expect(followUp).toContain("age");
  });

  test("recovers JSON wrapped in a code block", async () => {
    const { provider } = scripted(['```json\n{"name":"Ada","age":36}\n```']);
    const r = await generateStructured(provider, {
      messages: [{ role: "user", content: "x" }],
      schema: Person,
    });
    expect(r.ok).toBe(true);
  });

  test("fails explicitly after exhausting retries (does not return partial data)", async () => {
    const { provider } = scripted(['{"name":"Ada"}']); // age is always missing
    const r = await generateStructured(
      provider,
      { messages: [{ role: "user", content: "x" }], schema: Person },
      { maxRetries: 1 }
    );

    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.attempts).toBe(2);
    expect(r.error).toContain("age");
    expect(r.raw).toBeDefined(); // the raw output is kept for diagnosis
  });

  test("accumulates tokens from all attempts", async () => {
    const { provider } = scripted(['{"bad":1}', '{"name":"Ada","age":36}']);
    const r = await generateStructured(provider, {
      messages: [{ role: "user", content: "x" }],
      schema: Person,
    });
    expect(r.tokensIn).toBe(20); // 2 attempts × 10
    expect(r.tokensOut).toBe(10);
  });

  test("'prompt' mode injects the schema as a system instruction", async () => {
    const { provider, calls } = scripted(['{"name":"Ada","age":36}'], "prompt");
    await generateStructured(provider, {
      messages: [{ role: "user", content: "x" }],
      schema: Person,
    });

    const system = calls[0].messages.find((m: any) => m.role === "system");
    expect(system.content).toContain("JSON Schema");
  });

  test("garbage text fails cleanly, without throwing", async () => {
    const { provider } = scripted(["sorry, I cannot"]);
    const r = await generateStructured(
      provider,
      { messages: [{ role: "user", content: "x" }], schema: Person },
      { maxRetries: 0 }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});
