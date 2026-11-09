/**
 * System Routes
 * - Theme management (Module-Aware Themes / Prism)
 * - CSS serving
 * - Module dependency resolution on theme activation
 *
 * NOTE: /init-check and /setup are handled inline in index.ts (before auth middleware).
 * These routes are for authenticated system management.
 */

import { join } from "node:path";

import { messageOf } from "@kitsuden/engine";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { db } from "../db";
import { siteSettings, modules } from "../db/schema";
import { adminMfaMode } from "../lib/admin-mfa";
import { fileBody, file } from "../lib/file";
import { protectRoute } from "../middleware/auth-guard";
import { CORE_MODULES, CORE_MODULE_KEYS } from "../services/module-registry";
import { scanPackages, scanPackages as scanGrimoires } from "../services/scanner";

export const systemRoutes = new Hono();

/**
 * Get all kons (both required and optional) for a grimoire
 */
async function getGrimoireKons(
  grimoireId: string
): Promise<{ required: string[]; optional: string[] }> {
  const grimoires = await scanGrimoires("grimoires");
  const grimoire = grimoires.find((r) => r.id === grimoireId);

  if (!grimoire) {
    return { required: [], optional: [] };
  }

  return {
    required: grimoire.kons || [],
    optional: grimoire.optional_kons || [],
  };
}

// ── Helper: get currently enabled module keys ──
async function getEnabledModuleKeys(): Promise<Set<string>> {
  const dbModules = await db.select().from(modules);
  const dbMap = new Map(dbModules.map((m) => [m.key, m]));
  const enabled = new Set<string>();

  for (const cm of CORE_MODULES) {
    const stored = dbMap.get(cm.key);
    const isEnabled = stored ? stored.enabled : cm.category === "core";
    if (isEnabled) enabled.add(cm.key);
  }

  // Filesystem modules
  for (const [k, v] of dbMap) {
    if (!CORE_MODULE_KEYS.includes(k) && v.enabled) enabled.add(k);
  }

  return enabled;
}

// ── GET /themes — List installed themes (with module awareness) ──
export async function listThemesHandler(c: any) {
  const themes = await scanPackages("themes");
  const [settings] = await db.select().from(siteSettings).limit(1);
  const activeId = settings?.activeTheme || "kitsuden-default";
  const enabledKeys = await getEnabledModuleKeys();

  return c.json({
    docs: themes.map((t) => {
      const required = t.requires_modules || [];
      const optional = t.optional_modules || [];

      // Check which required modules are missing
      const missingRequired = required.filter((k) => !enabledKeys.has(k));
      const missingOptional = optional.filter((k) => !enabledKeys.has(k));

      return {
        ...t,
        isActive: t.id === activeId,
        // Module awareness fields
        requires_modules: required,
        optional_modules: optional,
        missing_required: missingRequired,
        missing_optional: missingOptional,
        modules_satisfied: missingRequired.length === 0,
      };
    }),
  });
}
systemRoutes.get("/themes", listThemesHandler);

/**
 * GET /auth-providers — which OAuth is ACTUALLY configured.
 *
 * Without this, a login screen can only do two bad things: draw buttons for
 * providers nobody has configured (and which lead to a 404 after the
 * redirect), or hardcode them and get out of sync with the server.
 *
 * It returns ONLY the identifiers. That a provider is active is not
 * secret —it shows in the button itself— but the credentials do not leave here,
 * and that is why they are read and discarded on the same line.
 */
export function listAuthProvidersHandler(c: Context) {
  const configured: Array<{ id: string; label: string }> = [];
  const add = (id: string, label: string, ...required: Array<string | undefined>) => {
    if (required.every(Boolean)) configured.push({ id, label });
  };

  add("github", "GitHub", process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET);
  add("google", "Google", process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  add("microsoft", "Microsoft", process.env.AZURE_AD_CLIENT_ID, process.env.AZURE_AD_CLIENT_SECRET);
  add("discord", "Discord", process.env.DISCORD_CLIENT_ID, process.env.DISCORD_CLIENT_SECRET);

  // `magicLink` and `twoFactor` are always on (lib/auth.ts); `adminMfa` tells the
  // panel whether an admin without a second factor must enrol before anything else.
  return c.json({
    emailAndPassword: true,
    magicLink: true,
    twoFactor: true,
    adminMfa: adminMfaMode(),
    social: configured,
  });
}
systemRoutes.get("/auth-providers", listAuthProvidersHandler);

/**
 * The only part of the grimoire.json `config` the panel needs:
 * `config.theme` (read by `applyGrimoireTheme` in packages/admin/src/lib/theme.svelte.ts).
 * Without this the grimoire's theme was never applied. It is copied field by field and
 * strings only: the rest of `config` (or keys a third party puts in
 * `theme`) does not leave, in case some manifest carries something it should not.
 */
export function grimoirePublicConfig(config: unknown): {
  theme?: {
    primary_color?: string;
    accent_color?: string;
    secondary_color?: string;
    css_vars?: Record<string, string>;
  };
} {
  const theme = (config as { theme?: unknown } | null | undefined)?.theme;
  if (!theme || typeof theme !== "object") return {};
  const t = theme as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["primary_color", "accent_color", "secondary_color"] as const) {
    if (typeof t[key] === "string") output[key] = t[key];
  }
  if (t.css_vars && typeof t.css_vars === "object") {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.css_vars as Record<string, unknown>)) {
      if (k.startsWith("--kitsuden-") && typeof v === "string") vars[k] = v;
    }
    output.css_vars = vars;
  }
  return { theme: output };
}

// ── GET /grimoires — List installed grimoires with detailed kon info ──
export async function listGrimoiresHandler(c: any) {
  const grimoires = await scanPackages("grimoires");
  const [settings] = await db.select().from(siteSettings).limit(1);
  const allModules = await db.select().from(modules);
  const modulesMap = new Map(allModules.map((m) => [m.key, m]));

  // Support both legacy activeTheme and new activeGrimoire
  const activeId = (settings as any)?.activeGrimoire || settings?.activeTheme || null;

  const result = await Promise.all(
    grimoires.map(async (r) => {
      const required = r.kons || [];
      const optional = r.optional_kons || [];

      // Get detailed info for each kon
      const konDetails = [...required, ...optional].map((gId) => {
        const mod = modulesMap.get(gId);
        return {
          key: gId,
          name: mod?.name || gId,
          installed: !!mod,
          enabled: mod?.enabled || false,
          isGrimoireLinked: mod?.grimoireId === r.id,
          category: mod?.category || "optional",
        };
      });

      return {
        id: r.id,
        name: r.name,
        description: r.description,
        version: r.version,
        isActive: r.id === activeId,
        config: grimoirePublicConfig((r as { config?: unknown }).config),
        kons: {
          required,
          optional,
          details: konDetails,
          installedCount: konDetails.filter((g) => g.installed).length,
          enabledCount: konDetails.filter((g) => g.enabled).length,
        },
        canDelete: r.id !== activeId, // Cannot delete active grimoire
      };
    })
  );

  return c.json(result);
}
systemRoutes.get("/grimoires", listGrimoiresHandler);

// ── GET /grimoires/:id — Get detailed info about a specific grimoire ──
export async function getGrimoireHandler(c: any) {
  const grimoireId = c.req.param("id");
  const grimoires = await scanPackages("grimoires");
  const grimoire = grimoires.find((r) => r.id === grimoireId);

  if (!grimoire) {
    return c.json({ error: `Grimoire '${grimoireId}' not found` }, 404);
  }

  const [settings] = await db.select().from(siteSettings).limit(1);
  const allModules = await db.select().from(modules);
  const modulesMap = new Map(allModules.map((m) => [m.key, m]));

  const activeId = (settings as any)?.activeGrimoire || settings?.activeTheme || null;
  const isActive = grimoireId === activeId;

  const required = grimoire.kons || [];
  const optional = grimoire.optional_kons || [];

  const konDetails = [...required, ...optional].map((gId) => {
    const mod = modulesMap.get(gId);
    return {
      key: gId,
      name: mod?.name || gId,
      installed: !!mod,
      enabled: mod?.enabled || false,
      isGrimoireLinked: mod?.grimoireId === grimoireId,
      grimoireId: mod?.grimoireId || null,
      category: mod?.category || "optional",
      canDelete: !mod?.enabled, // Can only delete if not enabled
    };
  });

  return c.json({
    id: grimoire.id,
    name: grimoire.name,
    description: grimoire.description,
    version: grimoire.version,
    isActive,
    kons: {
      required,
      optional,
      details: konDetails,
      installedCount: konDetails.filter((g) => g.installed).length,
      enabledCount: konDetails.filter((g) => g.enabled).length,
    },
    canDelete: !isActive,
    canDeactivate: isActive,
  });
}
systemRoutes.get("/grimoires/:id", getGrimoireHandler);

export async function themeCheckHandler(c: Context) {
  const themeId = c.req.param("id");
  const themes = await scanPackages("themes");
  const theme = themes.find((t) => t.id === themeId);

  if (!theme) return c.json({ error: "Theme not found" }, 404);

  const enabledKeys = await getEnabledModuleKeys();
  const required = theme.requires_modules || [];
  const optional = theme.optional_modules || [];

  const missingRequired = required.filter((k) => !enabledKeys.has(k));
  const missingOptional = optional.filter((k) => !enabledKeys.has(k));

  // Resolve module names for display
  const allModules = CORE_MODULES;
  const resolveModule = (key: string) => {
    const cm = allModules.find((m) => m.key === key);
    return {
      key,
      name: cm?.name || key,
      icon: cm?.icon || "📦",
      description: cm?.description || "",
      category: cm?.category || "optional",
      enabled: enabledKeys.has(key),
    };
  };

  return c.json({
    theme: { id: theme.id, name: theme.name, theme_type: theme.theme_type },
    canActivate: true, // Always allow — missing modules just disable features
    requires: missingRequired.map(resolveModule),
    optional: missingOptional.map(resolveModule),
    allSatisfied: missingRequired.length === 0 && missingOptional.length === 0,
  });
}
systemRoutes.get("/themes/:id/check", protectRoute, themeCheckHandler);

// ── PATCH /active-theme — Activate theme (with auto grimoire kons activation) ──
systemRoutes.patch("/active-theme", protectRoute, async (c) => {
  const body = await c.req.json();
  const { themeId, enableModules } = body;

  if (!themeId) return c.json({ error: "themeId required" }, 400);

  // Validate theme exists
  const themes = await scanPackages("themes");
  const theme = themes.find((t) => t.id === themeId);
  if (!theme) return c.json({ error: "Theme not found" }, 404);

  // Get all kons from the grimoire (required + optional)
  const { required, optional } = await getGrimoireKons(themeId);
  const allGrimoireKons = [...required, ...optional];

  console.log(
    `[Grimoire Activation] Grimoire ${themeId} has ${required.length} required and ${optional.length} optional kons`
  );

  // Auto-install and auto-enable all grimoire kons
  const installedModules: string[] = [];
  const activatedModules: string[] = [];

  for (const konId of allGrimoireKons) {
    // Find kon info from scanner (filesystem kons)
    const kons = await scanPackages("kons");
    const kon = kons.find((g) => g.id === konId);

    // Also check hardcoded registry
    const registryDef = CORE_MODULES.find((m) => m.key === konId);

    const [existing] = await db.select().from(modules).where(eq(modules.key, konId)).limit(1);

    if (existing) {
      // Update grimoireId to link to this grimoire and ensure enabled
      if (!existing.enabled || existing.grimoireId !== themeId) {
        await db
          .update(modules)
          .set({
            enabled: true,
            grimoireId: themeId,
          })
          .where(eq(modules.key, konId));
        activatedModules.push(konId);
      }
    } else {
      // Insert new module record linked to this grimoire
      await db.insert(modules).values({
        key: konId,
        name: kon?.name || registryDef?.name || konId,
        description: kon?.description || registryDef?.description,
        icon: kon?.icon || registryDef?.icon || "📦",
        category: "grimoire",
        enabled: true,
        grimoireId: themeId,
        settings: {},
        sidebarBadge: "Active by Grimoire",
      });
      installedModules.push(konId);
      activatedModules.push(konId);
    }

    // Run migrations if needed
    try {
      const { runModuleMigrations } = await import("../services/scanner");
      await runModuleMigrations(konId);
    } catch (err) {
      console.error(`[Grimoire Activation] Migration error for kon ${konId}:`, err);
    }
  }

  // Also handle any manually specified modules (backward compatibility)
  if (enableModules && Array.isArray(enableModules) && enableModules.length > 0) {
    for (const moduleKey of enableModules) {
      // Skip if already processed as grimoire kon
      if (allGrimoireKons.includes(moduleKey)) continue;

      const registryDef = CORE_MODULES.find((m) => m.key === moduleKey);
      const [existing] = await db.select().from(modules).where(eq(modules.key, moduleKey)).limit(1);

      if (existing) {
        if (!existing.enabled) {
          await db.update(modules).set({ enabled: true }).where(eq(modules.key, moduleKey));
          activatedModules.push(moduleKey);
        }
      } else {
        await db.insert(modules).values({
          key: moduleKey,
          name: registryDef?.name || moduleKey,
          description: registryDef?.description,
          icon: registryDef?.icon,
          category: registryDef?.category || "optional",
          enabled: true,
          settings: {},
        });
        activatedModules.push(moduleKey);
      }

      try {
        const { runModuleMigrations } = await import("../services/scanner");
        await runModuleMigrations(moduleKey);
      } catch (err) {
        console.error(`[Theme Activation] Migration error for module ${moduleKey}:`, err);
      }
    }
  }

  // Activate the theme
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (settings) {
    await db
      .update(siteSettings)
      .set({ activeTheme: themeId })
      .where(eq(siteSettings.id, settings.id));
  } else {
    await db.insert(siteSettings).values({ activeTheme: themeId });
  }

  console.log(
    `[Grimoire Activation] Grimoire ${themeId} activated with ${installedModules.length} new kons installed and ${activatedModules.length} total activated`
  );

  return c.json({
    success: true,
    activeTheme: themeId,
    installedModules,
    activatedModules,
    grimoireKons: allGrimoireKons,
    message:
      installedModules.length > 0
        ? `Grimoire activated. Installed ${installedModules.length} new kons and activated ${activatedModules.length} total.`
        : `Grimoire activated. ${activatedModules.length} kons active.`,
  });
});

export async function deactivateThemeHandler(c: Context) {
  const [settings] = await db.select().from(siteSettings).limit(1);
  const currentGrimoireId = settings?.activeTheme || null;

  if (!currentGrimoireId) {
    return c.json({
      success: true,
      message: "No grimoire currently active.",
      deactivatedModules: [],
    });
  }

  const deactivatedModules: string[] = [];
  const grimoireModulesList = await db
    .select()
    .from(modules)
    .where(eq(modules.grimoireId, currentGrimoireId));

  for (const mod of grimoireModulesList) {
    if (mod.enabled) {
      await db.update(modules).set({ enabled: false }).where(eq(modules.key, mod.key));
      deactivatedModules.push(mod.key);
    }
  }

  if (settings) {
    await db
      .update(siteSettings)
      .set({ activeTheme: null })
      .where(eq(siteSettings.id, settings.id));
  }

  return c.json({
    success: true,
    deactivatedGrimoire: currentGrimoireId,
    deactivatedModules,
    message:
      deactivatedModules.length > 0
        ? `Grimoire ${currentGrimoireId} deactivated. Disabled ${deactivatedModules.length} kons.`
        : `Grimoire ${currentGrimoireId} deactivated.`,
  });
}
systemRoutes.delete("/active-theme", protectRoute, deactivateThemeHandler);

// ── POST /grimoire-state — Activate or deactivate a grimoire with full control ──
systemRoutes.post("/grimoire-state", protectRoute, async (c) => {
  const body = await c.req.json();
  const { action, grimoireId, options = {} } = body;

  if (!action || !["activate", "deactivate"].includes(action)) {
    return c.json({ error: "action must be 'activate' or 'deactivate'" }, 400);
  }

  // Get current active grimoire
  const [settings] = await db.select().from(siteSettings).limit(1);
  const currentActiveGrimoire = settings?.activeTheme || null;

  if (action === "deactivate") {
    // If grimoireId specified, only deactivate if it matches current
    if (grimoireId && grimoireId !== currentActiveGrimoire) {
      return c.json(
        {
          error: "Cannot deactivate",
          message: `Grimoire ${grimoireId} is not currently active. Active grimoire is: ${currentActiveGrimoire || "none"}.`,
        },
        400
      );
    }

    // Deactivate current grimoire
    const targetGrimoire = currentActiveGrimoire;
    if (!targetGrimoire) {
      return c.json({
        success: true,
        message: "No grimoire currently active.",
        deactivatedModules: [],
      });
    }

    const deactivatedModules: string[] = [];
    const keepEnabled = options.keepKonsEnabled || false;

    if (!keepEnabled) {
      // Get all modules linked to this grimoire and disable them
      const grimoireModulesList = await db
        .select()
        .from(modules)
        .where(eq(modules.grimoireId, targetGrimoire));

      for (const mod of grimoireModulesList) {
        if (mod.enabled) {
          await db.update(modules).set({ enabled: false }).where(eq(modules.key, mod.key));
          deactivatedModules.push(mod.key);
        }
      }
    }

    // Clear active theme/grimoire
    if (settings) {
      await db
        .update(siteSettings)
        .set({ activeTheme: null })
        .where(eq(siteSettings.id, settings.id));
    }

    return c.json({
      success: true,
      action: "deactivate",
      deactivatedGrimoire: targetGrimoire,
      deactivatedModules,
      keptEnabled: keepEnabled,
      message: keepEnabled
        ? `Grimoire ${targetGrimoire} deactivated. Kons kept enabled.`
        : `Grimoire ${targetGrimoire} deactivated. Disabled ${deactivatedModules.length} kons.`,
    });
  }

  // action === "activate"
  if (!grimoireId) {
    return c.json({ error: "grimoireId is required for activation" }, 400);
  }

  // If there's an active grimoire, deactivate it first
  if (currentActiveGrimoire && currentActiveGrimoire !== grimoireId) {
    // Optionally disable its kons
    const disablePrevious = options.disablePreviousGrimoire !== false; // default true

    if (disablePrevious) {
      const previousModules = await db
        .select()
        .from(modules)
        .where(eq(modules.grimoireId, currentActiveGrimoire));

      for (const mod of previousModules) {
        if (mod.enabled) {
          await db.update(modules).set({ enabled: false }).where(eq(modules.key, mod.key));
        }
      }
    }
  }

  // Validate grimoire exists
  const grimoires = await scanPackages("grimoires");
  const grimoire = grimoires.find((r) => r.id === grimoireId);
  if (!grimoire) return c.json({ error: "Grimoire not found" }, 404);

  // Get all kons from the grimoire
  const { required, optional } = await getGrimoireKons(grimoireId);
  const allGrimoireKons = [...required, ...optional];

  // Auto-install and auto-enable all grimoire kons
  const installedModules: string[] = [];
  const activatedModules: string[] = [];

  for (const konId of allGrimoireKons) {
    const kons = await scanPackages("kons");
    const kon = kons.find((g) => g.id === konId);
    const registryDef = CORE_MODULES.find((m) => m.key === konId);

    const [existing] = await db.select().from(modules).where(eq(modules.key, konId)).limit(1);

    if (existing) {
      if (!existing.enabled || existing.grimoireId !== grimoireId) {
        await db
          .update(modules)
          .set({
            enabled: true,
            grimoireId,
          })
          .where(eq(modules.key, konId));
        activatedModules.push(konId);
      }
    } else {
      await db.insert(modules).values({
        key: konId,
        name: kon?.name || registryDef?.name || konId,
        description: kon?.description || registryDef?.description,
        icon: kon?.icon || registryDef?.icon || "📦",
        category: "grimoire",
        enabled: true,
        grimoireId,
        settings: {},
        sidebarBadge: "Active by Grimoire",
      });
      installedModules.push(konId);
      activatedModules.push(konId);
    }

    // Run migrations
    try {
      const { runModuleMigrations } = await import("../services/scanner");
      await runModuleMigrations(konId);
    } catch (err) {
      console.error(`[Grimoire Activation] Migration error for kon ${konId}:`, err);
    }
  }

  // Activate the grimoire
  if (settings) {
    await db
      .update(siteSettings)
      .set({ activeTheme: grimoireId })
      .where(eq(siteSettings.id, settings.id));
  } else {
    await db.insert(siteSettings).values({ activeTheme: grimoireId });
  }

  return c.json({
    success: true,
    action: "activate",
    activeGrimoire: grimoireId,
    installedModules,
    activatedModules,
    grimoireKons: allGrimoireKons,
    previousGrimoire: currentActiveGrimoire,
    message:
      installedModules.length > 0
        ? `Grimoire ${grimoireId} activated. Installed ${installedModules.length} new kons and activated ${activatedModules.length} total.`
        : `Grimoire ${grimoireId} activated. ${activatedModules.length} kons active.`,
  });
});

// ── DELETE /grimoires/:id — Delete/Uninstall a grimoire ──
systemRoutes.delete("/grimoires/:id", protectRoute, async (c) => {
  const grimoireId = c.req.param("id");
  const deleteKons = c.req.query("deleteKons") === "true";
  const force = c.req.query("force") === "true";

  // Check if grimoire exists
  const grimoires = await scanPackages("grimoires");
  const grimoire = grimoires.find((r) => r.id === grimoireId);

  if (!grimoire) {
    return c.json({ error: `Grimoire '${grimoireId}' not found` }, 404);
  }

  // Get current active grimoire
  const [settings] = await db.select().from(siteSettings).limit(1);
  const isCurrentlyActive = settings?.activeTheme === grimoireId;

  // Get all kons linked to this grimoire
  const grimoireKons = await db.select().from(modules).where(eq(modules.grimoireId, grimoireId));

  const enabledKons = grimoireKons.filter((g) => g.enabled);

  // If grimoire is active or has enabled kons, require force
  if ((isCurrentlyActive || enabledKons.length > 0) && !force) {
    return c.json(
      {
        error: "Cannot delete grimoire",
        message: `Grimoire ${grimoireId} is currently active or has enabled kons. Deactivate it first or use ?force=true to force deletion.`,
        isActive: isCurrentlyActive,
        enabledKons: enabledKons.map((g) => g.key),
        totalKons: grimoireKons.length,
      },
      409
    );
  }

  const result: any = {
    success: true,
    deletedGrimoire: grimoireId,
    grimoireName: grimoire.name,
    wasActive: isCurrentlyActive,
  };

  if (deleteKons) {
    // Delete all kons linked to this grimoire
    const deletedKons: string[] = [];

    for (const kon of grimoireKons) {
      await db.delete(modules).where(eq(modules.key, kon.key));
      deletedKons.push(kon.key);
    }

    result.deletedKons = deletedKons;
    result.konsKept = [];
    result.message = `Grimoire ${grimoireId} deleted along with ${deletedKons.length} kons.`;
  } else {
    // Keep kons but convert to standalone (remove grimoireId)
    const keptKons: string[] = [];

    for (const kon of grimoireKons) {
      await db
        .update(modules)
        .set({
          grimoireId: null,
          category: "optional",
          sidebarBadge: null,
        })
        .where(eq(modules.key, kon.key));
      keptKons.push(kon.key);
    }

    result.deletedKons = [];
    result.konsKept = keptKons;
    result.message = `Grimoire ${grimoireId} deleted. ${keptKons.length} kons converted to standalone.`;
  }

  // If this grimoire was active, clear the active theme
  if (isCurrentlyActive && settings) {
    await db
      .update(siteSettings)
      .set({ activeTheme: null })
      .where(eq(siteSettings.id, settings.id));
    result.clearedActiveTheme = true;
  }

  console.log(
    `[Grimoire Deletion] Grimoire ${grimoireId} deleted. deleteKons=${deleteKons}, kons affected: ${grimoireKons.length}`
  );

  return c.json(result);
});

// ── GET /active-theme-config — Returns parsed theme JSON for the Theme Engine ──
export async function getActiveThemeConfigHandler(c: any) {
  try {
    const [settings] = await db.select().from(siteSettings).limit(1);
    const activeId = settings?.activeTheme || "kitsuden-default";

    const themes = await scanPackages("themes");
    const theme = themes.find((t) => t.id === activeId);

    if (!theme) {
      return c.json({ theme: null, branding: settings?.branding || null });
    }

    // Try to read a theme.json with color/logo overrides
    const themeConfig: Record<string, unknown> = {
      id: theme.id,
      name: theme.name,
    };

    // Parse variables.css to extract color definitions
    const cssPath = join(
      process.cwd(),
      "../../packages/grimoires",
      activeId,
      theme.css_entry || "variables.css"
    );
    try {
      const cssFile = file(cssPath);
      if (await cssFile.exists()) {
        const cssContent = await cssFile.text();
        const colors: Record<string, string> = {};
        // Extract --kitsuden-* variables from CSS
        const varRegex = /--kitsuden-([\w-]+)\s*:\s*([^;]+)/g;
        let match;
        while ((match = varRegex.exec(cssContent)) !== null) {
          const key = match[1].trim();
          const value = match[2].trim();
          // Map CSS var names back to theme config keys
          const keyMap: Record<string, string> = {
            bg: "background",
            card: "card",
            border: "border",
            text: "text",
            "text-dim": "textDim",
            cyan: "primary",
            pink: "secondary",
            purple: "accent",
            green: "success",
            amber: "warning",
            surface: "surface",
          };
          if (keyMap[key]) colors[keyMap[key]] = value;
        }
        if (Object.keys(colors).length > 0) themeConfig.colors = colors;

        // Extract font variables
        const fonts: Record<string, string> = {};
        const fontRegex = /--font-(display|body|mono)\s*:\s*([^;]+)/g;
        while ((match = fontRegex.exec(cssContent)) !== null) {
          fonts[match[1].trim()] = match[2].trim();
        }
        if (Object.keys(fonts).length > 0) themeConfig.fonts = fonts;
      }
    } catch (e) {
      // CSS parsing non-fatal
    }

    // Also try to read a dedicated theme.json if it exists
    const themeJsonPath = join(process.cwd(), "../../packages/grimoires", activeId, "theme.json");
    try {
      const jsonFile = file(themeJsonPath);
      if (await jsonFile.exists()) {
        const overrides = await jsonFile.json();
        if (overrides.colors)
          themeConfig.colors = { ...(themeConfig.colors || {}), ...overrides.colors };
        if (overrides.logos) themeConfig.logos = overrides.logos;
        if (overrides.fonts)
          themeConfig.fonts = { ...(themeConfig.fonts || {}), ...overrides.fonts };
      }
    } catch (e) {
      // theme.json is optional
    }

    return c.json({
      theme: themeConfig,
      branding: settings?.branding || null,
    });
  } catch (err: unknown) {
    return c.json({ theme: null, branding: null, error: messageOf(err) }, 500);
  }
}
systemRoutes.get("/active-theme-config", getActiveThemeConfigHandler);

// ── GET /theme-css/:themeId — Serve theme CSS variables ──
export async function getThemeCssHandler(c: any) {
  const themeId = c.req.param("themeId");

  if (themeId.includes("..") || themeId.includes("/") || themeId.includes("\\")) {
    return c.text("/* Invalid theme ID */", 400);
  }

  const themes = await scanPackages("themes");
  const theme = themes.find((t) => t.id === themeId);

  if (!theme) return c.text("/* Theme not found */", 404);

  const cssFile = theme.css_entry || "variables.css";
  const cssPath = join(process.cwd(), "../../packages/grimoires", themeId, cssFile);

  try {
    const themeCss = file(cssPath);
    if (await themeCss.exists()) {
      return new Response(fileBody(cssPath).body, {
        headers: { "Content-Type": "text/css" },
      });
    }
  } catch (e) {
    console.error("Theme CSS error:", e);
  }

  return c.text(`/* CSS not found for ${themeId} */`, 404);
}
systemRoutes.get("/theme-css/:themeId", getThemeCssHandler);
