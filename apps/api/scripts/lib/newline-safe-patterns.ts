/**
 * `$` that means the same to Schemathesis's generator as to the API
 * ============================================================================
 *
 * A JSON Schema `pattern` is an ECMA regex: there, without the `m` flag, `$` matches
 * only at the end of the string. Schemathesis generates values with Hypothesis,
 * which reads the pattern as a Python regex, where `$` ALSO matches before a final
 * "\n". So about a third of the values it makes for `^…$` end in "\n"; its own
 * check (ECMA) rejects them and it throws the example away. A body with several
 * patterned fields keeps almost nothing, and Schemathesis fails its
 * `filter_too_much` health check. This happened to POST /conta/journals/validate
 * in kitsuden-kons (four patterns per journal line), and only on Python 3.14,
 * because the version changes which random path is taken first.
 *
 * `$(?!\n)` means exactly `$` in ECMA (at the end, nothing follows) and, in Python,
 * rules out the position before a final "\n". Only the spec that the Schemathesis
 * runner writes is rewritten: the published OpenAPI and the SDK keep `$`.
 */

/** What is appended after a `$` anchor (the regex source `(?!\n)`). */
export const NO_FINAL_NEWLINE = "(?!\\n)";

/**
 * Appends `(?!\n)` after every `$` anchor of an ECMA regex: an unescaped `$`,
 * outside a character class, followed by the end, `|` or `)`. A `$` that already
 * has it is left alone, so running it twice changes nothing.
 */
export function newlineSafePattern(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      // An escape takes the next character as is (`\$`, `\]`, `\\`).
      out += ch + (pattern[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      // `[]…]` and `[^]…]`: a `]` right after the opening is a literal one.
      if (pattern[i + 1] === "^") out += pattern[++i];
      if (pattern[i + 1] === "]") out += pattern[++i];
      continue;
    }
    out += ch;
    if (ch !== "$") continue;
    const next = pattern[i + 1];
    const anchorsTheEnd = next === undefined || next === "|" || next === ")";
    if (anchorsTheEnd && !pattern.startsWith(NO_FINAL_NEWLINE, i + 1)) out += NO_FINAL_NEWLINE;
  }
  return out;
}

/** Keys whose values are data (examples, defaults), not schemas: never rewritten. */
const LITERALS = new Set(["default", "enum", "const", "example", "examples"]);
/** Maps of NAME → schema: a field may be called `default` or `enum` and is still a schema. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "schemas", "dependentSchemas"]);

/**
 * A copy of an OpenAPI document (or any JSON Schema) with every `pattern`, and every
 * `patternProperties` key, made newline-safe. Counts how many changed in `changed`.
 */
export function newlineSafeSpec<T>(doc: T, changed = { count: 0 }): T {
  if (Array.isArray(doc)) return doc.map((d) => newlineSafeSpec(d, changed)) as T;
  if (!doc || typeof doc !== "object") return doc;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (SCHEMA_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
          name,
          newlineSafeSpec(schema, changed),
        ])
      );
    } else if (LITERALS.has(key)) {
      out[key] = value;
    } else if (key === "pattern" && typeof value === "string") {
      const safe = newlineSafePattern(value);
      if (safe !== value) changed.count++;
      out[key] = safe;
    } else if (key === "patternProperties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [regex, schema] of Object.entries(value as Record<string, unknown>)) {
        const safe = newlineSafePattern(regex);
        if (safe !== regex) changed.count++;
        props[safe] = newlineSafeSpec(schema, changed);
      }
      out[key] = props;
    } else {
      out[key] = newlineSafeSpec(value, changed);
    }
  }
  return out as T;
}
