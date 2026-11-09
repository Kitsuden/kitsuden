/**
 * Interface strings
 * ============================================================================
 *
 * One dictionary per language, all with the keys of `en.ts`. To add one:
 *
 *   1. copy `en.ts` to `es.ts` and translate the values;
 *   2. add it to `DICTIONARIES` below;
 *   3. set `SITE_LOCALE=es`.
 *
 * The locale also travels to the blog API (`?locale=`), which returns one
 * version per post: the one in that language if it exists, else the English
 * one. Content stays in Kitsuden; only the interface lives here.
 */
import { en, type MessageKey } from "./en";

const DICTIONARIES: Record<string, Partial<Record<MessageKey, string>>> = { en };

export const DEFAULT_LOCALE = "en";
export const LOCALES = Object.keys(DICTIONARIES);

export type Locale = string;

export function resolveLocale(value: unknown): Locale {
  return typeof value === "string" && value in DICTIONARIES ? value : DEFAULT_LOCALE;
}

/** Translate `key`, filling `{name}` placeholders. Missing keys fall back to English. */
export function t(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {}
): string {
  const text = DICTIONARIES[locale]?.[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function formatDate(locale: Locale, value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(
    date
  );
}
