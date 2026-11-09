/**
 * Register Default Widgets
 *
 * Example of how to register dynamic widgets and components.
 * In a real implementation, this could come from:
 * - Dynamically loaded modules
 * - External apps through an API
 * - Installed plugins
 */

// @ts-ignore - Unused imports preserved for future widget registration
import { componentRegistry } from "./registry.svelte";

// Example widgets - documentation for a future implementation
void {
  // RecentActivityWidget
  id: "kitsuden-recent-activity",
  slot: "dashboard:sidebar",
  component: null, // (await import("../components/widgets/RecentActivityWidget.svelte")).default,
  order: 10,
  module: "core",
  props: { limit: 5 },
};

/**
 * Register all the default widgets
 */
export async function registerDefaultWidgets() {
  // In a real implementation, we would load this from the API
  // or from dynamic modules
  // For now, we simulate the registration
  // Example of how to register a widget:
  // componentRegistry.registerWidget(RecentActivityWidget);
  // Note: Real dynamic loading would require dynamic import() calls
  // that are resolved at runtime
}

/**
 * Register widgets from an external API
 */
export async function registerWidgetsFromAPI() {
  try {
    // `??`, not `||`: in production VITE_API_URL is "" (relative paths behind
    // nginx) and `||` turned it into localhost:3001 inside the bundle.
    const API = import.meta.env.VITE_API_URL ?? "";
    const res = await fetch(`${API}/api/admin/widgets`, {
      credentials: "include",
    });

    if (!res.ok) return;

    const { widgets, modules } = await res.json();

    // Update enabled modules
    componentRegistry.setEnabledModules(modules);

    // Register widgets
    for (const _widget of widgets) {
      // In production, here we would load the component dynamically
      // const component = await import(widget.componentUrl);
      // componentRegistry.registerWidget({ ...widget, component: component.default });
    }
  } catch (e) {
    console.warn("Failed to load widgets from API:", e);
  }
}
