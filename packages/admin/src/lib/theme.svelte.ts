import { t as tr } from "$lib/i18n";
/**
 * Theme Engine (Svelte 5 Runes)
 * Loads and applies active theme CSS variables
 */

interface ThemeConfig {
  id: string;
  name: string;
  description: string;
  preview: string;
  primary?: string;
  secondary?: string;
  accent?: string;
  cssVars?: Record<string, string>;
}

// Default themes
export const themes: ThemeConfig[] = [
  {
    id: "mocha",
    name: tr("theme.mocha"),
    description: tr("theme.deepElegantDarkMode"),
    preview: "linear-gradient(135deg, #1e1e2e, #cba6f7)",
    cssVars: {
      "--kitsuden-primary": "137 180 250",
      "--kitsuden-accent": "137 180 250",
      "--kitsuden-secondary": "243 139 168",
      "--kitsuden-accent-2": "243 139 168",
      "--kitsuden-purple": "203 166 247",

      "--kitsuden-bg": "17 17 27",
      "--kitsuden-card": "24 24 37",
      "--kitsuden-surface": "30 30 46",
      "--kitsuden-border": "49 50 68",
      "--kitsuden-muted": "69 71 90",
      "--kitsuden-subtle": "88 91 112",
      "--kitsuden-text": "205 214 244",
      "--kitsuden-text-dim": "166 173 200",
      "--kitsuden-green": "166 227 161",
      "--kitsuden-amber": "249 226 175",
      "--kitsuden-yellow": "249 226 175",
      "--kitsuden-danger": "243 139 168",
      "--kitsuden-accent-dim": "116 156 222",
      "--kitsuden-accent-hover": "167 200 250",
    },
  },
  {
    id: "latte",
    name: tr("theme.latte"),
    description: tr("theme.warmSoothingLightMode"),
    preview: "linear-gradient(135deg, #eff1f5, #8839ef)",
    cssVars: {
      "--kitsuden-primary": "30 102 245",
      "--kitsuden-accent": "30 102 245",
      "--kitsuden-secondary": "210 15 57",
      "--kitsuden-accent-2": "210 15 57",
      "--kitsuden-purple": "136 57 239",

      "--kitsuden-bg": "239 241 245",
      "--kitsuden-card": "255 255 255",
      "--kitsuden-surface": "230 233 239",
      "--kitsuden-border": "188 192 204",
      "--kitsuden-muted": "172 176 190",
      "--kitsuden-subtle": "140 143 161",
      "--kitsuden-text": "76 79 105",
      "--kitsuden-text-dim": "92 95 119",
      "--kitsuden-green": "64 160 43",
      "--kitsuden-amber": "223 142 29",
      "--kitsuden-yellow": "228 147 40",
      "--kitsuden-danger": "210 15 57",
      "--kitsuden-accent-dim": "47 87 183",
      "--kitsuden-accent-hover": "90 140 220",
    },
  },
];

// ── Theme state (Svelte 5 runes) ────────────────────────────────────────
// It used to be a `writable` from svelte/store; now it is a rune, consistent with the
// rest of the panel. It is exposed through a getter (`currentTheme()`) instead of `$store`:
// runes do not auto-subscribe with `$` outside a component.
let theme = $state<string>("mocha");
let themeLoaded = $state(false);

/** Id of the active theme (reactive). */
export function currentTheme(): string {
  return theme;
}

export function getThemeLoaded() {
  return themeLoaded;
}

export async function loadTheme() {
  try {
    // 1) Theme of the active grimoire (branding of the installed "theme").
    //    A grimoire can redefine the panel's visuals via
    //    config.theme in its grimoire.json (KITSUDEN architecture: grimoire =
    //    set of kons that form a theme, including the admin).
    await applyGrimoireTheme();

    // 2) The user's local preference (mocha/latte) — wins over the grimoire
    const saved = localStorage.getItem("kitsuden-theme");
    if (saved) {
      const found = themes.find((t) => t.id === saved);
      if (found) {
        applyTheme(found);
        theme = saved;
      }
    }
  } catch {
    // localStorage not available — use default (already in CSS)
  } finally {
    themeLoaded = true;
  }
}

export function setTheme(themeId: string) {
  const found = themes.find((t) => t.id === themeId);
  if (found) {
    applyTheme(found);
    theme = themeId;
    localStorage.setItem("kitsuden-theme", themeId);
  }
}

function applyTheme(theme: Partial<ThemeConfig>) {
  const root = document.documentElement;

  if (theme.cssVars) {
    for (const [key, value] of Object.entries(theme.cssVars)) {
      root.style.setProperty(key, value);
    }
  }

  if (theme.primary) {
    root.style.setProperty("--kitsuden-primary", theme.primary);
    root.style.setProperty("--kitsuden-accent", theme.primary);
  }

  if (theme.secondary) {
    root.style.setProperty("--kitsuden-secondary", theme.secondary);
    root.style.setProperty("--kitsuden-accent-2", theme.secondary);
  }

  if (theme.accent) {
    root.style.setProperty("--kitsuden-accent", theme.accent);
    root.style.setProperty("--kitsuden-purple", theme.accent);
  }
}

// ═══════════════════════════════════════════════════════════════
// GRIMOIRE THEME — KITSUDEN architecture
// A grimoire (set of kons that form a theme) can redefine
// the control panel's visuals via `config.theme` in grimoire.json:
//
//   "config": {
//     "theme": {
//       "primary_color": "#a855f7",
//       "accent_color": "#ff2d6f",
//       "css_vars": { "--kitsuden-bg": "9 9 11" }   // optional, advanced
//     }
//   }
// ═══════════════════════════════════════════════════════════════

const API_URL = import.meta.env.VITE_API_URL ?? "";

interface GrimoireThemeConfig {
  primary_color?: string;
  accent_color?: string;
  secondary_color?: string;
  css_vars?: Record<string, string>;
}

/** Converts #rgb / #rrggbb to an "r g b" triplet (format of the --kitsuden-* vars) */
function hexToTriplet(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3)
    h = h
      .split("")
      .map((ch) => ch + ch)
      .join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/** Derives dim (-18%) and hover (+18%) variants from a triplet */
function shade(triplet: string, factor: number): string {
  return triplet
    .split(" ")
    .map((n) => {
      const v = Math.round(Number(n) * factor);
      return String(Math.max(0, Math.min(255, v)));
    })
    .join(" ");
}

const SAFE_VAR_KEY = /^--kitsuden-[a-z0-9-]+$/;
const SAFE_VAR_VALUE = /^(#[0-9a-fA-F]{3,8}|[\d\s.%]+)$/;

/**
 * Applies the active grimoire's theme to the panel's CSS variables.
 * Silent no-op if there is no active grimoire or it defines no theme.
 * Call after activating/deactivating a grimoire to refresh live.
 */
export async function applyGrimoireTheme(): Promise<void> {
  try {
    const [grimoiresRes, settingsRes] = await Promise.all([
      fetch(`${API_URL}/api/system/grimoires`, { credentials: "include" }),
      fetch(`${API_URL}/api/settings`, { credentials: "include" }),
    ]);
    if (!grimoiresRes.ok || !settingsRes.ok) return;

    const grimoires = (await grimoiresRes.json()) as Array<{
      id: string;
      config?: { theme?: GrimoireThemeConfig };
    }>;
    const settings = (await settingsRes.json()) as {
      activeGrimoire?: string | null;
      activeTheme?: string | null;
    };

    const activeId = settings.activeGrimoire || settings.activeTheme || null;
    if (!activeId) return;

    const active = grimoires.find((g) => g.id === activeId);
    const theme = active?.config?.theme;
    if (!theme) return;

    const root = document.documentElement;

    const primary = theme.primary_color ? hexToTriplet(theme.primary_color) : null;
    if (primary) {
      root.style.setProperty("--kitsuden-primary", primary);
      root.style.setProperty("--kitsuden-accent", primary);
      root.style.setProperty("--kitsuden-accent-dim", shade(primary, 0.82));
      root.style.setProperty("--kitsuden-accent-hover", shade(primary, 1.18));
      if (theme.primary_color) {
        root.style.setProperty("--kitsuden-color-primary", theme.primary_color);
      }
    }

    const accentHex = theme.accent_color || theme.secondary_color;
    const accent = accentHex ? hexToTriplet(accentHex) : null;
    if (accent && accentHex) {
      root.style.setProperty("--kitsuden-secondary", accent);
      root.style.setProperty("--kitsuden-accent-2", accent);
      root.style.setProperty("--kitsuden-accent-2-dim", shade(accent, 0.82));
      root.style.setProperty("--kitsuden-color-secondary", accentHex);
    }

    // advanced css_vars: only sanitized keys/values (defense against
    // CSS injection from a third-party manifest)
    if (theme.css_vars) {
      for (const [key, value] of Object.entries(theme.css_vars)) {
        if (SAFE_VAR_KEY.test(key) && SAFE_VAR_VALUE.test(value)) {
          root.style.setProperty(key, value);
        }
      }
    }
  } catch {
    // The grimoire's theme is cosmetic: it never blocks the panel
  }
}

/** Restores the inline CSS vars (back to the style.css defaults) */
export function resetGrimoireTheme(): void {
  const root = document.documentElement;
  for (const key of [
    "--kitsuden-primary",
    "--kitsuden-accent",
    "--kitsuden-accent-dim",
    "--kitsuden-accent-hover",
    "--kitsuden-color-primary",
    "--kitsuden-secondary",
    "--kitsuden-accent-2",
    "--kitsuden-accent-2-dim",
    "--kitsuden-color-secondary",
  ]) {
    root.style.removeProperty(key);
  }
}
