/**
 * Grimoire View Registry — Legacy Override System
 *
 * ⚠️ DEPRECATION WARNING: This file is gradually being replaced by auto-detection.
 *
 * NEW APPROACH (Zero Config):
 * - Create file at: packages/admin/src/views/{grimoire}/{PascalCase}View.svelte
 * - The system auto-detects it via /api/admin/registry endpoint
 *
 * This file now serves as:
 * 1. OVERRIDE registry for complex views that need special handling
 * 2. BACKWARD COMPATIBILITY for existing custom views
 *
 * Examples of when to use this registry:
 * - Views that need special import paths
 * - Views with circular dependencies
 * - Views that need preprocessing
 */

import type { Component } from "svelte";

/**
 * Manual overrides for custom views.
 * These take precedence over auto-detection.
 */
export const GRIMOIRE_VIEW_REGISTRY: Record<string, () => Promise<{ default: Component }>> = {
  // Complex views with special requirements

  // Games uses a special layout
  games: () => import("$views/games/GamesView.svelte"),

  // NOTE: Other grimoires will use auto-detection
  // Just create: packages/admin/src/views/{grimoire}/{Grimoire}View.svelte
};

/**
 * Check if a grimoire has a manual override
 */
export function hasManualOverride(grimoireId: string): boolean {
  return grimoireId in GRIMOIRE_VIEW_REGISTRY;
}

/**
 * Get list of manually registered grimoires
 */
export function getManualOverrides(): string[] {
  return Object.keys(GRIMOIRE_VIEW_REGISTRY);
}
