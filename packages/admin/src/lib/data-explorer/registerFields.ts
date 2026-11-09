/**
 * Registration of default DataExplorer field components
 *
 * This file registers all the default field components.
 * Grimoires can register their own additional components.
 */

// Import base components
import BooleanField from "$lib/components/data-explorer/fields/BooleanField.svelte";
import CalculatedField from "$lib/components/data-explorer/fields/CalculatedField.svelte";
import DateField from "$lib/components/data-explorer/fields/DateField.svelte";
import NumberField from "$lib/components/data-explorer/fields/NumberField.svelte";
import StatusBadgeField from "$lib/components/data-explorer/fields/StatusBadgeField.svelte";
import TextField from "$lib/components/data-explorer/fields/TextField.svelte";

import { fieldRegistry } from "./fieldRegistry";

/**
 * Register all default field types
 */
export function registerDefaultFields() {
  // Basic fields
  fieldRegistry.register("text", TextField);
  fieldRegistry.register("textarea", TextField); // For now it uses the same one, it can be extended
  fieldRegistry.register("email", TextField);
  fieldRegistry.register("url", TextField);
  fieldRegistry.register("slug", TextField);

  // Numeric
  fieldRegistry.register("number", NumberField);

  // Booleans
  fieldRegistry.register("boolean", BooleanField);

  // Dates
  fieldRegistry.register("date", DateField);
  fieldRegistry.register("datetime", DateField);

  // Status
  fieldRegistry.register("status-badge", StatusBadgeField);
  fieldRegistry.register("select", StatusBadgeField); // For simple enums

  // Calculated
  fieldRegistry.register("calculated", CalculatedField);

  // Default for any unregistered type
  // (this is handled in the main component)
}

// Auto-register on import
registerDefaultFields();
