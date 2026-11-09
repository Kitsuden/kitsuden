/**
 * The panel speaks two languages and no visible text is left outside the dictionary
 * ============================================================================
 *
 * Three checks, each against a different way of breaking it:
 *
 *   1. en.ts and es.ts have EXACTLY the same keys, none empty, and
 *      the same `{placeholders}`: if Spanish loses a `{count}`, the figure
 *      disappears from the screen with no error.
 *   2. Every key the code requests with t("...") exists. A missing key
 *      breaks nothing: the raw key is rendered, which is exactly what is not seen
 *      in a quick review.
 *   3. Loose-text heuristic: every .svelte is parsed looking for text nodes with letters
 *      (and hand-written placeholder/title/aria-label/alt/label attributes). A new text
 *      without t() fails here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { parse } from "svelte/compiler";
import { describe, expect, it, vi } from "vitest";

import en from "./en";
import es from "./es";
import { t, setLocale, getLocale } from "./locale.svelte";

const SRC = join(__dirname, "..", "..");

// Parsing ~200 .svelte files takes several seconds with the suite running in parallel.
vi.setConfig({ testTimeout: 120_000 });

type Dic = Record<string, Record<string, string>>;

function flatten(d: Dic): Map<string, string> {
  const m = new Map<string, string>();
  for (const [ns, keys] of Object.entries(d))
    for (const [k, v] of Object.entries(keys)) m.set(`${ns}.${k}`, v);
  return m;
}

const EN = flatten(en as Dic);
const ES = flatten(es as Dic);

const markers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sources(ext: RegExp): string[] {
  const r: string[] = [];
  (function traverse(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) traverse(p);
      else if (ext.test(e.name) && !/\.test\.ts$/.test(e.name)) r.push(p);
    }
  })(SRC);
  return r;
}

describe("diccionarios", () => {
  it("en and es have the same keys", () => {
    const onlyIn = [...EN.keys()].filter((k) => !ES.has(k));
    const onlyIs = [...ES.keys()].filter((k) => !EN.has(k));
    expect({ onlyIn, onlyIs }).toEqual({ onlyIn: [], onlyIs: [] });
  });

  it("no empty text", () => {
    const empties = [...EN, ...ES].filter(([, v]) => !v.trim()).map(([k]) => k);
    expect(empties).toEqual([]);
  });

  it("both languages carry the same {placeholders}", () => {
    const distinctItems = [...EN].filter(
      ([k, v]) => markers(v).join() !== markers(ES.get(k) ?? "").join()
    );
    expect(distinctItems.map(([k]) => k)).toEqual([]);
  });
});

describe("keys used in the code", () => {
  it("every key requested with t()/tr() exists in both languages", () => {
    const areMissing: string[] = [];
    for (const f of sources(/\.(svelte|ts)$/)) {
      if (f.includes(`${sep}i18n${sep}`)) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\btr?\(\s*"([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)"/g)) {
        if (!EN.has(m[1]) || !ES.has(m[1])) areMissing.push(`${relative(SRC, f)}: ${m[1]}`);
      }
    }
    expect(areMissing).toEqual([]);
  });
});

/**
 * What may stay hand-written: proper names and acronyms that are not
 * translated. The shorter the list, the more useful the test.
 */
const ALLOWED = new Set([
  "Kitsuden",
  "Kitsuden Admin",
  "Kitsuden CMS",
  "API",
  "MCP",
  "SEO",
  "JSON",
  "CSV",
  "URL",
]);
const WITHOUT_TEXT = new Set(["code", "pre", "kbd", "samp", "textarea", "style", "script"]);
const ATTRIBUTES = new Set(["placeholder", "title", "aria-label", "alt", "label"]);

function hasLetters(s: string): boolean {
  return /\p{L}{2,}/u.test(s);
}

/**
 * Technical examples in attributes (mostly placeholders): URLs, lowercase
 * keys, `sk-...`, colors, acronyms. They are the same in any language.
 * They are only forgiven in ATTRIBUTES: in a text node, «clear» is a word.
 */
function isTechnicalExample(s: string): boolean {
  return (
    /^https?:\/\//.test(s) ||
    /^[a-z0-9_.\-/]+$/.test(s) ||
    /^[a-z]{2,}-\.{3}$/.test(s) ||
    /^#[0-9a-f]{3,8}$/i.test(s) ||
    /^[A-Z0-9]{2,4}$/.test(s)
  );
}

describe("visible text outside the dictionary (heuristic)", () => {
  it("no .svelte leaves text with letters without passing through t()", () => {
    const loose: string[] = [];
    for (const f of sources(/\.svelte$/)) {
      const src = readFileSync(f, "utf8");
      const ast = parse(src, { modern: true }) as unknown as { fragment: unknown };
      const annotate = (text: string, node: { start: number }) => {
        const clean = text.replace(/\s+/g, " ").trim();
        if (!hasLetters(clean) || ALLOWED.has(clean)) return;
        const line = src.slice(0, node.start).split("\n").length;
        loose.push(`${relative(SRC, f)}:${line} «${clean.slice(0, 60)}»`);
      };
      const visit = (node: unknown, parent: string | null): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach((n) => visit(n, parent));
        const n = node as Record<string, unknown> & { type?: string; name?: string };
        if (n.type === "Text" && !WITHOUT_TEXT.has(parent ?? ""))
          annotate(String(n.data), n as { start: number });
        if (
          Array.isArray(n.attributes) &&
          (n.type === "RegularElement" || n.type === "Component")
        ) {
          for (const a of n.attributes as Array<Record<string, unknown>>) {
            if (
              a.type !== "Attribute" ||
              !ATTRIBUTES.has(String(a.name)) ||
              !Array.isArray(a.value)
            )
              continue;
            for (const part of a.value as Array<Record<string, unknown>>) {
              if (part.type === "Text" && !isTechnicalExample(String(part.data).trim()))
                annotate(String(part.data), part as unknown as { start: number });
            }
          }
        }
        for (const [k, v] of Object.entries(n)) {
          if (
            [
              "attributes",
              "expression",
              "metadata",
              "parent",
              "instance",
              "module",
              "css",
              "options",
            ].includes(k)
          )
            continue;
          if (v && typeof v === "object") visit(v, typeof n.name === "string" ? n.name : parent);
        }
      };
      visit(ast.fragment, null);
    }
    expect(loose).toEqual([]);
  });
});

describe("t()", () => {
  it("English by default, interpolates and falls back to English", () => {
    expect(getLocale()).toBe("en");
    expect(t("languageSwitcher.language")).toBe("Language");
    expect(t("common.more", { v: 3 })).toBe("+3 more");
    expect(t("no.such-key")).toBe("no.such-key");
  });

  it("Spanish is chosen and saved", () => {
    setLocale("es", { reload: false });
    expect(t("languageSwitcher.language")).toBe("Idioma");
    expect(localStorage.getItem("kitsuden-admin-locale")).toBe("es");
    setLocale("en", { reload: false });
    expect(t("languageSwitcher.language")).toBe("Language");
  });
});
