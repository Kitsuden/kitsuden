/**
 * The models an agent can be set to, in the panel's model pickers
 * ============================================================================
 *
 * One list for the agent list's "new agent" form and the agent's own settings
 * (it used to be two hand-written copies, still offering GPT-4 and Claude 3).
 * Labels are product names, the same in every language.
 *
 * Current as of November 2026, from each provider's own model list:
 *   Anthropic  platform.claude.com (Claude Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5)
 *   OpenAI     developers.openai.com/api/docs/models (GPT-6.2 Astra and Sol, GPT-6 Luna)
 *   DeepSeek   api-docs.deepseek.com (deepseek-flash, deepseek-v4-pro)
 * Update it when a provider retires a model; an agent that still has an older
 * value keeps it (see `modelOptions`).
 */

export interface ModelOption {
  value: string;
  label: string;
}

/** Newest and most capable first within each provider. */
export const LLM_MODELS: readonly ModelOption[] = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "claude-fable-5-2", label: "Claude Fable 5.2" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { value: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
  { value: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
  { value: "gpt-6-luna", label: "GPT-6 Luna" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { value: "deepseek-flash", label: "DeepSeek Flash" },
];

/** What a new agent starts with. */
export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

/**
 * The options for a picker showing `current`. A value that is no longer on the
 * list (an agent saved with "gpt-4") stays visible and selected instead of the
 * select silently showing another model.
 */
export function modelOptions(current?: string | null): ModelOption[] {
  const options = [...LLM_MODELS];
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}
