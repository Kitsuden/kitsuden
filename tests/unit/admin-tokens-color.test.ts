/**
 * The admin's color tokens are named by their role, not by their hue
 * ============================================================================
 *
 * The admin accent used to be cyan and the tokens were called `--kitsuden-cyan` /
 * `text-kitsuden-cyan`. When the palette changed to violet, the name came to
 * describe a color that no longer existed: whoever read `text-kitsuden-cyan`
 * expected cyan and got purple.
 *
 * They were renamed to `accent` and `accent-2` — 1,238 replacements in 90 files.
 * This test prevents the name from being tied to a specific hue again.
 *
 * ── WHAT THAT RENAMING TAUGHT ──────────────────────────────────────────────
 *
 * It was not a clean replacement, which is why there are two checks and not one:
 *
 *   · Tailwind's KEYS were called plain `cyan:`, without the `kitsuden-`
 *     prefix, so the replacement did not touch them. The markup asked for
 *     `bg-kitsuden-accent` and the configuration still offered
 *     `bg-kitsuden-cyan`. Nothing failed when writing: it failed when building,
 *     with "The `bg-kitsuden-accent` class does not exist".
 *
 *   · `theme.svelte.ts` ALREADY defined its own `--kitsuden-accent`, an alias of
 *     `--kitsuden-purple`. On renaming, the two keys collided in the same
 *     object literal and JavaScript keeps the last one: the accent would have
 *     become purple in every theme, without warning.
 *
 * Hence the test looks at the three pieces —variables, Tailwind keys and
 * markup— and not just one: each failed on its own.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ADMIN = join(ROOT, "packages", "admin");

/**
 * Hue names forbidden as an accent token.
 *
 * `green`, `amber`, `yellow` and `purple` are NOT here: there the hue IS the
 * meaning (green = correct, amber = warning), and renaming them would add
 * nothing. What is forbidden is naming the brand accent by its color, which is
 * exactly what changes when someone redesigns.
 */
const FORBIDDEN_TONES = ["cyan", "pink", "magenta", "teal", "violet"];

/** All the admin's source files. */
function files(): string[] {
  const output: string[] = [];
  const extensions = [".svelte", ".ts", ".js", ".css"];

  function traverse(dir: string): void {
    for (const input of readdirSync(dir, { withFileTypes: true })) {
      const route = join(dir, input.name);
      if (input.isDirectory()) {
        if (input.name === "node_modules" || input.name === "build") continue;
        traverse(route);
      } else if (extensions.some((e) => input.name.endsWith(e))) {
        output.push(route);
      }
    }
  }

  traverse(join(ADMIN, "src"));
  return output;
}

describe("the admin's color tokens", () => {
  const sources = files();

  it("there are files to inspect", () => {
    // Without this, a failure while walking would leave the list empty and everything would pass.
    expect(sources.length).toBeGreaterThan(50);
  });

  for (const tone of FORBIDDEN_TONES) {
    it(`no token is named '${tone}'`, () => {
      const culprits: string[] = [];
      for (const f of sources) {
        // Comments are ignored on purpose: the rule forbids USING the
        // token, not MENTIONING it. Documenting why it was renamed —and that
        // `text-kitsuden-cyan` no longer exists— is exactly what stops someone
        // from reintroducing it for not knowing the history.
        const code = readFileSync(f, "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((l) => !/^\s*(\/\/|\*)/.test(l))
          .join("\n");

        if (code.includes(`kitsuden-${tone}`)) {
          culprits.push(f.slice(ADMIN.length + 1).replace(/\\/g, "/"));
        }
      }

      expect(
        culprits,
        `These files use 'kitsuden-${tone}' as a color token:\n\n` +
          `${culprits.slice(0, 12).join("\n")}\n\n` +
          `Name tokens by their ROLE (accent, accent-2, danger), not by their ` +
          `hue. A name by hue expires as soon as someone changes the hue, ` +
          `and leaves the code saying one thing and painting another.`
      ).toEqual([]);
    });
  }

  it("the old color is not left hand-written, in any spelling", () => {
    /**
     * The old values: cyan `0 229 255` and pink `255 42 109`.
     *
     * They are checked here because a hand-written color does NOT go through the
     * tokens and therefore is not repainted when the palette changes: it stays as
     * it was, screaming next to the new accent.
     *
     * And it is checked with a spelling-tolerant pattern because it took
     * FOUR sweeps to get rid of them, and each one failed by assuming a
     * specific form:
     *
     *   · `rgba(0, 229, 255, .1)`   commas with spaces — the first
     *   · `rgb(0 229 255 / .1)`     spaces and slash   — 2 files
     *   · `rgba(0,229,255,0.1)`     no spaces          — inside an arbitrary
     *                                                    Tailwind class
     *   · `text-cyan-400`           Tailwind's NATIVE palette, foreign to our
     *                               tokens and therefore truly cyan
     */
    const FORBIDDEN = [
      { name: "cian", pattern: /rgba?\([^)]*\b0\s*[, ]\s*229\s*[, ]\s*255\b/ },
      { name: "old pink", pattern: /rgba?\([^)]*\b255\s*[, ]\s*42\s*[, ]\s*109\b/ },
      { name: "cyan hex", pattern: /#00e5ff/i },
      { name: "old pink hex", pattern: /#ff2a6d/i },
      { name: "Tailwind cyan palette", pattern: /\b[a-z]+-cyan-\d+\b/ },
    ];

    /**
     * Exception: CATEGORICAL palettes.
     *
     * `types/blocks.ts` assigns a color to each block type —12 distinct
     * hues— to tell them apart at a glance in the selector. There cyan and
     * pink are not the brand accent: they are two entries of a range, just
     * like the series of a chart. Repainting them to the accent color would make
     * two block types stop being distinguishable.
     *
     * This test once flagged them, and obeying it would have made the
     * product worse. The rule is about the ACCENT, not about everything cyan.
     */
    const CATEGORICAL_PALETTES = ["src/types/blocks.ts"];

    const culprits: string[] = [];
    for (const f of sources) {
      const relative = f.slice(ADMIN.length + 1).replace(/\\/g, "/");
      if (CATEGORICAL_PALETTES.includes(relative)) continue;

      const text = readFileSync(f, "utf-8");
      for (const { name: name, pattern: pattern } of FORBIDDEN) {
        if (pattern.test(text)) culprits.push(`${relative} (${name})`);
      }
    }

    expect(
      culprits,
      `These files carry the old color written by hand:\n\n` +
        `${culprits.slice(0, 12).join("\n")}\n\n` +
        `A hand-written color does not go through the tokens, so it is not repainted when ` +
        `the palette changes. Use var(--kitsuden-accent) or the classes ` +
        `kitsuden-accent / kitsuden-accent-2.`
    ).toEqual([]);
  });

  it("Tailwind keys match the CSS variables", () => {
    /**
     * The trap that broke the build: the keys of `tailwind.config.js` do not
     * carry the `kitsuden-` prefix, so a rename over
     * `kitsuden-cyan` leaves them untouched. The markup asks for a class that the
     * configuration no longer defines, and that is not seen until the CSS is compiled.
     */
    const config = readFileSync(join(ADMIN, "tailwind.config.js"), "utf-8");

    // Each line `key: "rgb(var(--kitsuden-XXX) / <alpha-value>)"`.
    const pairs = [...config.matchAll(/"?([\w-]+)"?:\s*"rgb\(var\(--kitsuden-([\w-]+)\)/g)];

    expect(pairs.length, "no colors found in tailwind.config.js").toBeGreaterThan(5);

    const misaligned = pairs
      .filter(([, key, variable]) => key !== variable)
      .map(([, key, variable]) => `key '${key}' -> variable '--kitsuden-${variable}'`);

    expect(
      misaligned,
      `tailwind.config.js has keys that do not match their variable:\n\n` +
        `${misaligned.join("\n")}\n\n` +
        `The class is named by the KEY (bg-kitsuden-<key>) and takes the value of ` +
        `the VARIABLE. If they diverge, the markup asks for a class that does not exist and the ` +
        `build fails with "The \`bg-kitsuden-...\` class does not exist" — or worse, ` +
        `the class exists and paints the wrong color.`
    ).toEqual([]);
  });

  it("theme.svelte.ts does not declare the same variable twice", () => {
    /**
     * An object literal with a repeated key is not an error in JavaScript: it
     * keeps the last one, silently. Here that meant that each theme's accent
     * became the purple value.
     */
    const p = join(ADMIN, "src", "lib", "theme.svelte.ts");
    if (!existsSync(p)) return;

    const text = readFileSync(p, "utf-8");
    const blocks = [...text.matchAll(/cssVars:\s*\{([\s\S]*?)\n\s*\}/g)];

    expect(blocks.length, "no cssVars blocks found").toBeGreaterThan(0);

    const repeatedItems: string[] = [];
    for (const [, body] of blocks) {
      const views = new Set<string>();
      for (const [, name] of body!.matchAll(/"(--kitsuden-[\w-]+)":/g)) {
        if (views.has(name!)) repeatedItems.push(name!);
        views.add(name!);
      }
    }

    expect(
      [...new Set(repeatedItems)],
      `theme.svelte.ts repeats variables inside the same cssVars block. ` +
        `JavaScript keeps the last one without warning, so the theme applies one ` +
        `color and the code appears to say another.`
    ).toEqual([]);
  });
});
