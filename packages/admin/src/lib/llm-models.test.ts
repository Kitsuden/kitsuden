import { describe, expect, it } from "vitest";

import { DEFAULT_LLM_MODEL, LLM_MODELS, modelOptions } from "./llm-models";

describe("the panel's model list", () => {
  it("offers no retired model (GPT-4, GPT-3.5, Claude 3)", () => {
    const values = LLM_MODELS.map((m) => m.value);
    for (const retired of [
      "gpt-4",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "claude-3-opus",
      "claude-3-sonnet",
    ]) {
      expect(values).not.toContain(retired);
    }
  });

  it("has unique values and starts new agents on a listed model", () => {
    const values = LLM_MODELS.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(DEFAULT_LLM_MODEL);
  });

  it("keeps an agent's older model visible instead of showing another one", () => {
    expect(modelOptions("gpt-4").at(-1)).toEqual({ value: "gpt-4", label: "gpt-4" });
    expect(modelOptions(DEFAULT_LLM_MODEL)).toHaveLength(LLM_MODELS.length);
    expect(modelOptions(null)).toHaveLength(LLM_MODELS.length);
  });
});
