/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GLOBAL REACTIVE STATE - Svelte 5 Runes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file implements the global state for datasets using the new
 * reactivity system of Svelte 5 ($state, $derived).
 *
 * ⚠️ IMPORTANT: Do not use old stores (writable, readable, derived).
 * Svelte 5 Runes provides fine-grained reactivity without boilerplate.
 *
 * Pattern: Reactive Class with $state + Singleton Instance
 */

import type {
  DatasetDefinition,
  CreateDatasetPayload,
  UpdateDatasetPayload,
} from "@kitsuden/shared";

// ═══════════════════════════════════════════════════════════════════════════
// API configuration
// ═══════════════════════════════════════════════════════════════════════════

const API_URL = import.meta.env.VITE_API_URL ?? "";

/**
 * Translates an API row into a `DatasetDefinition`.
 *
 * ── ONE ARRAY WITH TWO NAMES ───────────────────────────────────────────────
 *
 * In the database and in the API, a dataset's columns live in **`schema`**.
 * In `DatasetDefinition` from `@kitsuden/shared` —which is what this state
 * declares— they are called **`fields`**. Nobody translated between the two, so the
 * list read `dataset.fields` from a row that only carried `schema` and **every
 * dataset came out with "0 fields"**, including those with twenty
 * columns and thousands of rows. TypeScript did not see it: the response came in
 * as `any` and the type said one thing while the data carried another.
 *
 * The translation is done here, at the edge, so that from this point on
 * the declared type is true.
 */
function toDefinition(row: Record<string, unknown>): DatasetDefinition {
  const columns = row.schema ?? row.fields;
  return {
    ...(row as unknown as DatasetDefinition),
    fields: Array.isArray(columns) ? columns : [],
  } as DatasetDefinition;
}

// ═══════════════════════════════════════════════════════════════════════════
// DatasetStore class - Global Reactive State
// ═══════════════════════════════════════════════════════════════════════════

export class DatasetStore {
  // ─── Core Reactive State ───
  /** List of loaded datasets */
  datasets = $state<DatasetDefinition[]>([]);

  /** Loading state for async operations */
  isLoading = $state<boolean>(false);

  /** Currently selected dataset (for edit/detail view) */
  selectedDataset = $state<DatasetDefinition | null>(null);

  /** Current error, if any */
  error = $state<string | null>(null);

  // ─── Derived State ($derived) ───
  /** Total number of datasets */
  totalCount = $derived<number>(this.datasets.length);

  /** Datasets sorted by name */
  sortedDatasets = $derived<DatasetDefinition[]>(
    [...this.datasets].sort((a, b) => a.name.localeCompare(b.name))
  );

  /** Indicates whether any datasets are loaded */
  hasDatasets = $derived<boolean>(this.datasets.length > 0);

  // ═══════════════════════════════════════════════════════════════════════════
  // CRUD methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Loads all the datasets from the API
   * Mutates reactively: isLoading → datasets → error
   */
  async fetchDatasets(): Promise<void> {
    this.isLoading = true;
    this.error = null;

    try {
      const response = await fetch(`${API_URL}/api/datasets`, { credentials: "include" });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      // The API returns { docs: DatasetDefinition[], totalDocs: number }
      this.datasets = (data.docs || []).map(toDefinition);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to fetch datasets";
      console.error("[DatasetStore] fetchDatasets error:", err);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Gets a dataset by ID and selects it
   */
  async fetchDatasetById(id: string): Promise<DatasetDefinition | null> {
    this.isLoading = true;
    this.error = null;

    try {
      const response = await fetch(`${API_URL}/api/datasets/${id}`, { credentials: "include" });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const dataset = toDefinition(await response.json());
      this.selectedDataset = dataset;
      return dataset;
    } catch (err) {
      this.error = err instanceof Error ? err.message : `Failed to fetch dataset ${id}`;
      console.error(`[DatasetStore] fetchDatasetById(${id}) error:`, err);
      return null;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Creates a new dataset
   * Optimistic update: adds to the local list immediately
   */
  async createDataset(payload: CreateDatasetPayload): Promise<DatasetDefinition | null> {
    this.isLoading = true;
    this.error = null;

    try {
      const response = await fetch(`${API_URL}/api/datasets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const newDataset = toDefinition(await response.json());
      // Reactive mutation: adds to the array
      this.datasets = [...this.datasets, newDataset];
      return newDataset;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to create dataset";
      console.error("[DatasetStore] createDataset error:", err);
      return null;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Updates an existing dataset
   */
  async updateDataset(
    id: string,
    payload: UpdateDatasetPayload
  ): Promise<DatasetDefinition | null> {
    this.isLoading = true;
    this.error = null;

    try {
      const response = await fetch(`${API_URL}/api/datasets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const updatedDataset = toDefinition(await response.json());

      // Updates in the local array
      this.datasets = this.datasets.map((ds) => (ds.id === id ? updatedDataset : ds));

      // If it is selected, updates that too
      if (this.selectedDataset?.id === id) {
        this.selectedDataset = updatedDataset;
      }

      return updatedDataset;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to update dataset";
      console.error(`[DatasetStore] updateDataset(${id}) error:`, err);
      return null;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Deletes a dataset
   */
  async deleteDataset(id: string): Promise<boolean> {
    this.isLoading = true;
    this.error = null;

    try {
      const response = await fetch(`${API_URL}/api/datasets/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Removes from the local array
      this.datasets = this.datasets.filter((ds) => ds.id !== id);

      // If it was selected, clears it
      if (this.selectedDataset?.id === id) {
        this.selectedDataset = null;
      }

      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to delete dataset";
      console.error(`[DatasetStore] deleteDataset(${id}) error:`, err);
      return false;
    } finally {
      this.isLoading = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI State methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Selects a dataset for edit/view
   */
  selectDataset(dataset: DatasetDefinition | null): void {
    this.selectedDataset = dataset;
  }

  /**
   * Clears the current error
   */
  clearError(): void {
    this.error = null;
  }

  /**
   * Resets the store to its initial state
   */
  reset(): void {
    this.datasets = [];
    this.selectedDataset = null;
    this.error = null;
    this.isLoading = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton Instance - Global Export
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Single instance of DatasetStore for global use.
 *
 * Usage in Svelte components:
 * ```svelte
 * <script>
 *   import { datasetStore } from '$lib/states/datasets.svelte';
 *
 *   // Direct access to reactive state
 *   $effect(() => {
 *     datasetStore.fetchDatasets();
 *   });
 * </script>
 *
 * {#if datasetStore.isLoading}
 *   <p>Loading...</p>
 * {:else}
 *   {#each datasetStore.datasets as dataset}
 *     <p>{dataset.name}</p>
 *   {/each}
 * {/if}
 * ```
 */
export const datasetStore = new DatasetStore();

// ═══════════════════════════════════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════════════════════════════════

export type { DatasetDefinition, CreateDatasetPayload, UpdateDatasetPayload };
