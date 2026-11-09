/**
 * Kitsuden — Component Registry (Svelte Edition)
 *
 * Dynamic component registration system for extensibility.
 * Replaces the Vue PluginRegistry with a native Svelte implementation.
 *
 * Features:
 * - Widget registration in named slots
 * - Dynamic route registration
 * - Block registration for the editor
 * - Toolbar action registration
 * - Support for enabled/disabled modules
 */

import type { Component } from "svelte";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface RegistryWidget {
  /** Unique identifier */
  id: string;
  /** Slot where it is rendered (e.g. "dashboard:top", "sidebar:bottom") */
  slot: string;
  /** Svelte component to render */
  component: Component;
  /** Render order (higher = first) */
  order: number;
  /** Module it belongs to (for filtering) */
  module?: string;
  /** Initial props for the component */
  props?: Record<string, unknown>;
  /** Additional metadata */
  meta?: Record<string, unknown>;
}

export interface RegistryRoute {
  /** Owning module */
  module: string;
  /** Route pattern (e.g. "/tournaments/:id") */
  path: string;
  /** Component to render */
  component: Component;
  /** Requires authentication */
  requiresAuth?: boolean;
  /** Layout to use (optional) */
  layout?: Component;
}

export interface RegistryBlock {
  /** Block type (unique identifier) */
  type: string;
  /** Display name */
  name: string;
  /** Icon (Lucide component) */
  icon?: Component;
  /** Edit component */
  editorComponent: Component;
  /** Preview/render component */
  renderComponent: Component;
  /** Props schema for the block */
  propsSchema?: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "select" | "media";
      label: string;
      default?: unknown;
      options?: { label: string; value: string }[];
    }
  >;
  /** Module it belongs to */
  module?: string;
}

export interface RegistryAction {
  id: string;
  label: string;
  /** Optional icon */
  icon?: Component;
  /** Handler when the action runs */
  handler: () => void | Promise<void>;
  /** Location: toolbar, context-menu, bulk-actions */
  location: "toolbar" | "context-menu" | "bulk-actions";
  /** Module it belongs to */
  module?: string;
  /** Order of appearance */
  order?: number;
  /** Condition to show the action */
  condition?: () => boolean;
}

// ═══════════════════════════════════════════════════════════════
// Registry Implementation
// ═══════════════════════════════════════════════════════════════

class ComponentRegistry {
  private widgets = new Map<string, RegistryWidget[]>();
  private routes: RegistryRoute[] = [];
  private blocks: RegistryBlock[] = [];
  private actions: RegistryAction[] = [];
  private enabledModules = new Set<string>();

  // ═══════════════════════════════════════════════════════════
  // Module Management
  // ═══════════════════════════════════════════════════════════

  /**
   * Sync enabled modules from the backend
   */
  setEnabledModules(modules: string[] | Set<string>): void {
    this.enabledModules = new Set(modules);
  }

  /**
   * Check whether a module is active
   */
  isModuleActive(module?: string): boolean {
    if (!module) return true;
    return this.enabledModules.has(module);
  }

  /**
   * Get the list of enabled modules
   */
  getEnabledModules(): string[] {
    return Array.from(this.enabledModules);
  }

  // ═══════════════════════════════════════════════════════════
  // Widgets
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a widget in a specific slot
   */
  registerWidget(widget: RegistryWidget): void {
    const { slot } = widget;

    if (!this.widgets.has(slot)) {
      this.widgets.set(slot, []);
    }

    const slotWidgets = this.widgets.get(slot)!;

    // Avoid duplicates by ID
    const existingIndex = slotWidgets.findIndex((w) => w.id === widget.id);
    if (existingIndex >= 0) {
      slotWidgets[existingIndex] = widget;
    } else {
      slotWidgets.push(widget);
    }

    // Sort by descending order
    slotWidgets.sort((a, b) => b.order - a.order);
  }

  /**
   * Get widgets for a specific slot
   */
  getWidgets(slot: string): RegistryWidget[] {
    const allWidgets = this.widgets.get(slot) || [];
    return allWidgets.filter((w) => this.isModuleActive(w.module));
  }

  /**
   * Get all available slots
   */
  getSlots(): string[] {
    return Array.from(this.widgets.keys());
  }

  /**
   * Remove a widget by ID
   */
  unregisterWidget(slot: string, id: string): void {
    const slotWidgets = this.widgets.get(slot);
    if (slotWidgets) {
      this.widgets.set(
        slot,
        slotWidgets.filter((w) => w.id !== id)
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Routes
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a dynamic route
   */
  registerRoute(route: RegistryRoute): void {
    // Avoid duplicates
    const exists = this.routes.some((r) => r.path === route.path && r.module === route.module);

    if (!exists) {
      this.routes.push(route);
    }
  }

  /**
   * Get routes filtered by active modules
   */
  getRoutes(): RegistryRoute[] {
    return this.routes.filter((r) => this.isModuleActive(r.module));
  }

  /**
   * Get a route by path
   */
  getRouteByPath(path: string): RegistryRoute | undefined {
    return this.routes.find((r) => this.isModuleActive(r.module) && r.path === path);
  }

  // ═══════════════════════════════════════════════════════════
  // Blocks
  // ═══════════════════════════════════════════════════════════

  /**
   * Register a block type
   */
  registerBlock(block: RegistryBlock): void {
    const existingIndex = this.blocks.findIndex((b) => b.type === block.type);

    if (existingIndex >= 0) {
      this.blocks[existingIndex] = block;
    } else {
      this.blocks.push(block);
    }
  }

  /**
   * Get all available blocks
   */
  getBlocks(): RegistryBlock[] {
    return this.blocks.filter((b) => this.isModuleActive(b.module));
  }

  /**
   * Get a block by type
   */
  getBlock(type: string): RegistryBlock | undefined {
    return this.blocks.find((b) => b.type === type && this.isModuleActive(b.module));
  }

  // ═══════════════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════════════

  /**
   * Register an action
   */
  registerAction(action: RegistryAction): void {
    const existingIndex = this.actions.findIndex((a) => a.id === action.id);

    if (existingIndex >= 0) {
      this.actions[existingIndex] = action;
    } else {
      this.actions.push(action);
    }

    // Sort by descending order
    this.actions.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  }

  /**
   * Get actions by location
   */
  getActions(location: RegistryAction["location"]): RegistryAction[] {
    return this.actions
      .filter((a) => a.location === location)
      .filter((a) => this.isModuleActive(a.module))
      .filter((a) => (a.condition ? a.condition() : true));
  }

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════

  /**
   * Remove all the registrations of a module
   */
  unregisterModule(moduleKey: string): void {
    // Widgets
    for (const [slot, widgets] of this.widgets) {
      this.widgets.set(
        slot,
        widgets.filter((w) => w.module !== moduleKey)
      );
    }

    // Routes
    this.routes = this.routes.filter((r) => r.module !== moduleKey);

    // Blocks
    this.blocks = this.blocks.filter((b) => b.module !== moduleKey);

    // Actions
    this.actions = this.actions.filter((a) => a.module !== moduleKey);

    // Remove from enabled modules
    this.enabledModules.delete(moduleKey);
  }

  /**
   * Clear the whole registry
   */
  clear(): void {
    this.widgets.clear();
    this.routes = [];
    this.blocks = [];
    this.actions = [];
    this.enabledModules.clear();
  }
}

// Singleton export
export const componentRegistry = new ComponentRegistry();

// Hook helper to access the registry
export function useRegistry() {
  return componentRegistry;
}
