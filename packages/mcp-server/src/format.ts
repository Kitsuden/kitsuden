/**
 * Text of an MCP result: compact JSON or TOON, the shortest that loses
 * nothing. It is the `auto` part of the API (apps/api/src/lib/formats.ts) that this
 * package can do without depending on it: no TRON (it would be one more
 * dependency) and no per-shape cache (here the results are small).
 *
 * Tools that read from the API ask for `Accept: application/vnd.kitsuden.auto`
 * and pass the body through as is; this is for data the server already has
 * as an object.
 */

import { decodeToon, encodeToon } from "./toon";

export type TextFormat = "json" | "toon" | "tron";

/** Below this it is not worth trying a format other than JSON. */
const MIN_THRESHOLD = 256;
/** TOON is only chosen if it saves at least this much compared to compact JSON. */
const MIN_MARGIN = 0.02;

export function resultText(data: unknown): { text: string; format: TextFormat } {
  const json = JSON.stringify(data) ?? "null";
  if (json.length < MIN_THRESHOLD) return { text: json, format: "json" };
  try {
    const toon = encodeToon(data);
    if (
      toon.length <= json.length * (1 - MIN_MARGIN) &&
      JSON.stringify(decodeToon(toon)) === json
    ) {
      return { text: toon, format: "toon" };
    }
  } catch {
    // Without TOON: JSON, which is the source
  }
  return { text: json, format: "json" };
}

/** Key of `_meta` that carries the text's format (the same one the API uses). */
export const META_FORMAT = "kitsuden/format";
