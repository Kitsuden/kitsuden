/**
 * Panel language.
 *
 * English by default; Spanish is chosen in the selector and saved to
 * localStorage, so it survives reloads and logouts.
 *
 * `t()` reads the language on every call and the state is `$state`, so
 * the markup repaints by itself. But some labels are evaluated once when loading
 * a module (block definitions, columns, menus): those would not find out.
 * That is why changing language reloads the page — it is the only way for NOTHING
 * to stay in the previous language.
 */
import en from "./en";
import es from "./es";

export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

type Dictionary = Record<string, Record<string, string>>;
const DICTIONARIES: Record<Language, Dictionary> = { en, es };

export const STORE_KEY = "kitsuden-admin-locale";

function readSaved(): Language {
  try {
    const v = globalThis.localStorage?.getItem(STORE_KEY);
    return v === "es" || v === "en" ? v : "en";
  } catch {
    return "en";
  }
}

const status = $state<{ language: Language }>({ language: readSaved() });

if (typeof document !== "undefined") document.documentElement.lang = status.language;

export function getLocale(): Language {
  return status.language;
}

/**
 * Changes the language and saves it. With `recargar` (the default) it reloads the page
 * so that labels computed while loading modules are translated too.
 */
export function setLocale(language: Language, { reload = true }: { reload?: boolean } = {}): void {
  if (!LANGUAGES.includes(language)) return;
  try {
    globalThis.localStorage?.setItem(STORE_KEY, language);
  } catch {
    /* storage blocked: the change lasts only for this session */
  }
  const change = language !== status.language;
  status.language = language;
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (change && reload && typeof location !== "undefined" && typeof window !== "undefined") {
    location.reload();
  }
}

function search(dic: Dictionary, key: string): string | undefined {
  const dot = key.indexOf(".");
  if (dot < 0) return undefined;
  return dic[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

/**
 * Translates `key` ("space.key") and interpolates `{name}` with `params`.
 * If it is missing in the active language it falls back to English, and if that
 * is missing too it returns the key, so the gap shows on screen instead of
 * staying blank.
 */
export function t(key: string, params?: Record<string, unknown>): string {
  const text = search(DICTIONARIES[status.language], key) ?? search(DICTIONARIES.en, key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (integer, name: string) =>
    name in params ? String(params[name] ?? "") : integer
  );
}

/**
 * BCP 47 tag for `toLocaleDateString`, `Intl.NumberFormat`, etc.
 * Before, each view set its own ("en-US" here, "es-ES" there) and a single
 * screen mixed dates in two languages.
 */
export function localeFormat(): string {
  return status.language === "es" ? "es-ES" : "en-US";
}

/** For tests: the dictionaries as they are. */
export const dictionaries = DICTIONARIES;
