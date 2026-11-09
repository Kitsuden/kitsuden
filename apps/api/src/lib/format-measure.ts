/**
 * Measure of the `auto` format savings within ONE call (no database)
 * ============================================================================
 *
 * `encodeResponse` (lib/formats.ts) records here each response it
 * encodes: how many characters and bytes its compact JSON had and how many were
 * sent. Whoever wants to know (the MCP route per call, the REST middleware
 * per request) opens a measure with `measureFormat` and reads it at the end; outside
 * a measure, recording does nothing. Kept separate from lib/format-savings.ts
 * (which stores to the database) so that formats.ts does not import the database: unit
 * tests and the SDK use it.
 *
 * Tokens: ESTIMATED with the `o200k_base` characters per token measured in
 * docs/agents/benchmarks.md §1 over 24 real responses (compact JSON 3.06;
 * TOON 3.10; TRON 2.81). It is not Claude's tokenizer (there is no offline one):
 * it is for comparing, not for billing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type MeasuredFormat = "json" | "toon" | "tron";

export const CHARACTERS_PER_TOKEN: Record<MeasuredFormat, number> = {
  json: 3.06,
  toon: 3.1,
  tron: 2.81,
};

export interface FormatMeasure {
  responses: number;
  /** Responses where something that was not JSON came out. */
  compacted: number;
  bytesJson: number;
  sentBytes: number;
  tokensJson: number;
  sentTokens: number;
}

export const emptyMeasure = (): FormatMeasure => ({
  responses: 0,
  compacted: 0,
  bytesJson: 0,
  sentBytes: 0,
  tokensJson: 0,
  sentTokens: 0,
});

const store = new AsyncLocalStorage<FormatMeasure>();

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Records an encoded response (does nothing outside `measureFormat`). */
export function annotateOutput(json: string, text: string, format: MeasuredFormat): void {
  const m = store.getStore();
  if (!m) return;
  m.responses++;
  if (format !== "json") m.compacted++;
  const bj = bytes(json);
  m.bytesJson += bj;
  m.sentBytes += format === "json" && text === json ? bj : bytes(text);
  m.tokensJson += json.length / CHARACTERS_PER_TOKEN.json;
  m.sentTokens += text.length / CHARACTERS_PER_TOKEN[format];
}

/** Runs `fn` measuring whatever it encodes. */
export async function measureFormat<T>(
  fn: () => Promise<T>
): Promise<{ value: T; measure: FormatMeasure }> {
  const measure = emptyMeasure();
  const value = await store.run(measure, fn);
  return { value, measure };
}

/** Opens a measure for the rest of this async execution (middleware). */
export function currentMeasure(): FormatMeasure | undefined {
  return store.getStore();
}

/** Like `measureFormat`, for synchronous code (the REST middleware). */
export function measureFormatSync<T>(fn: () => T): { value: T; measure: FormatMeasure } {
  const measure = emptyMeasure();
  const value = store.run(measure, fn);
  return { value, measure };
}

/**
 * Who stores the measures (lib/format-savings.ts registers itself when loaded).
 * This way the REST middleware reports without importing the database.
 */
type Listener = (agentId: string, channel: "mcp" | "rest", measure: FormatMeasure) => void;
let listener: Listener | null = null;

export function setSavingsListener(fn: Listener | null): void {
  listener = fn;
}

export function notifySavings(
  agentId: string | null | undefined,
  channel: "mcp" | "rest",
  measure: FormatMeasure
): void {
  if (!agentId || !listener) return;
  try {
    listener(agentId, channel, measure);
  } catch {
    // a statistic never breaks a response
  }
}
