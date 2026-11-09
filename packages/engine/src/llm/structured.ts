/**
 * Kitsuden — Guaranteed structured output
 * ============================================================================
 *
 * An agent that calls your API needs VALID arguments, not "almost always
 * valid". Asking for JSON in the prompt and hoping it comes out right is not
 * a contract: it is a bet.
 *
 * TECHNICAL NOTE on Outlines: its approach (constraining decoding token by
 * token) requires access to the model — vLLM, llama.cpp. With cloud APIs
 * (Anthropic, OpenAI) that is impossible: you can only use their native mode
 * and verify. That is why the guarantee here is built with three layers:
 *
 *   1. The provider's NATIVE MODE when it exists (OpenAI's json_schema,
 *      Anthropic's tool_use) — greatly reduces the error rate.
 *   2. VALIDATION with the same Zod the rest of the framework already uses.
 *   3. RETRY WITH THE ERROR fed back: the model is told exactly which
 *      field failed, which is what raises the success rate the most.
 *
 * The result is a validated type `T` or an explicit failure — never a
 * half-formed object that blows up three layers down.
 */

import { z, type ZodTypeAny } from "zod";

// ── Provider contract (injected) ─────────────────────────────────────────────

/** How this provider knows how to ask for structure. */
export type StructuredMode = "json_schema" | "tool" | "prompt";

export interface StructuredRequest {
  /** Conversation messages. */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** Expected JSON Schema (derived from the Zod). */
  schema: Record<string, unknown>;
  /** Name of the schema — some providers require it. */
  schemaName: string;
  mode: StructuredMode;
}

export interface StructuredProvider {
  readonly name: string;
  /** Native mode it supports. `prompt` = it can only be asked via text. */
  readonly structuredMode: StructuredMode;
  /** Returns the raw text the model produced. */
  complete(request: StructuredRequest): Promise<{
    text: string;
    tokensIn: number;
    tokensOut: number;
  }>;
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface StructuredResult<T> {
  ok: boolean;
  /** Present only if `ok`. Already validated by Zod. */
  data?: T;
  /** Reason for the failure after exhausting retries. */
  error?: string;
  /** Attempts used (1 = succeeded on the first). */
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  /** Raw text of the last attempt — for diagnostics. */
  raw?: string;
}

export interface StructuredOptions {
  /** Retries after the first failure. Default 2 (3 attempts in total). */
  maxRetries?: number;
  /** Extra context prepended as a system message. */
  system?: string;
}

// ── JSON extraction ──────────────────────────────────────────────────────────

/**
 * Extracts the JSON object from a response.
 *
 * Models often wrap the JSON in ```json ... ``` or add prose before
 * and after even when asked not to. Trying a direct `JSON.parse`
 * fails in these VERY frequent cases, so it is cleaned first.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // 1. As is.
  try {
    return JSON.parse(trimmed);
  } catch {
    // carry on
  }

  // 2. Inside a code block.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // carry on
    }
  }

  // 3. First balanced object or array in the text.
  const start = trimmed.search(/[{[]/);
  if (start !== -1) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error("The response does not contain parseable JSON");
}

// ── Zod → JSON Schema ────────────────────────────────────────────────────────

/**
 * Converts a Zod schema to JSON Schema (OpenAPI 3.0 dialect, the one LLM
 * providers ask for). It never throws: without the exact schema, Zod
 * validation remains the real guarantee.
 */
export async function toJsonSchema(
  schema: ZodTypeAny,
  _name: string
): Promise<Record<string, unknown>> {
  try {
    const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
      target: "openapi-3.0",
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    return rest;
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

/** Summarizes Zod errors into something a model can fix. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- ${path}: ${i.message}`;
    })
    .join("\n");
}

// ── Structured generation ────────────────────────────────────────────────────

/**
 * Asks the model for a response that matches `schema`, retrying with the
 * validation error if it fails.
 *
 * @example
 * const result = await generateStructured(provider, {
 *   messages: [{ role: "user", content: "Extract name and age from: Ada, 36" }],
 *   schema: z.object({ name: z.string(), age: z.number() }),
 *   schemaName: "Person",
 * });
 * if (result.ok) result.data.name; // typed and validated
 */
export async function generateStructured<S extends ZodTypeAny>(
  provider: StructuredProvider,
  input: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    schema: S;
    schemaName?: string;
  },
  options: StructuredOptions = {}
): Promise<StructuredResult<z.infer<S>>> {
  const maxRetries = options.maxRetries ?? 2;
  const schemaName = input.schemaName ?? "Output";
  const jsonSchema = await toJsonSchema(input.schema, schemaName);

  const messages = [...input.messages];
  if (options.system) {
    messages.unshift({ role: "system", content: options.system });
  }

  // With providers that have no native mode, the explicit instruction is all
  // there is: the schema is put up front so the model keeps it in mind.
  if (provider.structuredMode === "prompt") {
    messages.unshift({
      role: "system",
      content:
        "Reply ONLY with a valid JSON object that matches this JSON Schema. " +
        "No explanations, no code blocks, only the JSON.\n\n" +
        JSON.stringify(jsonSchema, null, 2),
    });
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let raw: string | undefined;
  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const response = await provider.complete({
      messages,
      schema: jsonSchema,
      schemaName,
      mode: provider.structuredMode,
    });

    tokensIn += response.tokensIn;
    tokensOut += response.tokensOut;
    raw = response.text;

    let candidate: unknown;
    try {
      candidate = extractJson(response.text);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Its own output and the problem are returned to it, which is what helps
      // it get it right on the next attempt the most.
      messages.push(
        { role: "assistant", content: response.text },
        {
          role: "user",
          content: `That is not valid JSON (${lastError}). Reply only with the JSON object.`,
        }
      );
      continue;
    }

    const parsed = input.schema.safeParse(candidate);
    if (parsed.success) {
      return { ok: true, data: parsed.data, attempts: attempt, tokensIn, tokensOut, raw };
    }

    lastError = describeIssues(parsed.error);
    messages.push(
      { role: "assistant", content: response.text },
      {
        role: "user",
        content:
          `The JSON does not match the schema. Fix these fields and reply again ` +
          `with only the JSON:\n${lastError}`,
      }
    );
  }

  return {
    ok: false,
    error: `No valid output after ${maxRetries + 1} attempts. Last error:\n${lastError}`,
    attempts: maxRetries + 1,
    tokensIn,
    tokensOut,
    raw,
  };
}
