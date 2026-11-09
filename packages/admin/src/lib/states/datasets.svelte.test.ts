import type { DatasetDefinition, CreateDatasetPayload } from "@kitsuden/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DatasetStore } from "./datasets.svelte";

describe("DatasetStore", () => {
  let store: DatasetStore;
  const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

  beforeEach(() => {
    store = new DatasetStore();
    vi.resetAllMocks();
  });

  describe("fetchDatasets", () => {
    it("should fetch datasets successfully", async () => {
      const mockDatasets: DatasetDefinition[] = [
        {
          id: "1",
          name: "Test Dataset",
          slug: "test-dataset",
          fields: [],
          createdAt: new Date().toISOString(),
        },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ docs: mockDatasets, totalDocs: 1 }),
      } as Response);

      await store.fetchDatasets();

      expect(store.datasets).toHaveLength(1);
      expect(store.datasets[0].name).toBe("Test Dataset");
      expect(store.isLoading).toBe(false);
      expect(store.error).toBeNull();
    });

    /**
     * The columns are called `schema` in the database and in the API, and `fields` in
     * `DatasetDefinition`. Without translation, the list read `dataset.fields` from
     * a row that only carried `schema`: **every dataset came out with "0
     * fields"**, including those with twenty columns and thousands of rows.
     */
    it("translates the API's `schema` to the `fields` the type declares", async () => {
      const columns = [
        { key: "name", label: "Name", type: "text" },
        { key: "slug", label: "Address", type: "text" },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          docs: [{ id: "1", name: "AFK Journey · Heroes", slug: "afk-heroes", schema: columns }],
          totalDocs: 1,
        }),
      } as Response);

      await store.fetchDatasets();

      expect(store.datasets[0].fields).toHaveLength(2);
      expect(store.datasets[0].fields[0].key).toBe("name");
    });

    it("a `schema` that is not an array does not break the list", async () => {
      // The creation route saved `{ fields: [] }` (an object) where everything
      // else expects an array
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          docs: [{ id: "1", name: "Odd", slug: "odd", schema: { fields: [] } }],
        }),
      } as Response);

      await store.fetchDatasets();

      expect(store.datasets[0].fields).toEqual([]);
    });

    it("should handle fetch error", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      await store.fetchDatasets();

      expect(store.datasets).toHaveLength(0);
      expect(store.error).toContain("500");
      expect(store.isLoading).toBe(false);
    });

    it("should set loading state while fetching", async () => {
      global.fetch = vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      const fetchPromise = store.fetchDatasets();
      expect(store.isLoading).toBe(true);

      await fetchPromise;
    });
  });

  describe("createDataset", () => {
    it("should create dataset successfully", async () => {
      const payload: CreateDatasetPayload = {
        name: "New Dataset",
        slug: "new-dataset",
        fields: [],
      };

      const mockResponse: DatasetDefinition = {
        id: "2",
        name: "New Dataset",
        slug: "new-dataset",
        fields: [],
        createdAt: new Date().toISOString(),
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await store.createDataset(payload);

      expect(result).toEqual(mockResponse);
      expect(store.datasets).toHaveLength(1);
      expect(store.datasets[0].name).toBe("New Dataset");
    });

    it("should handle create error", async () => {
      const payload: CreateDatasetPayload = {
        name: "New Dataset",
        slug: "new-dataset",
        fields: [],
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "Invalid data" }),
      } as Response);

      const result = await store.createDataset(payload);

      expect(result).toBeNull();
      expect(store.error).toContain("Invalid data");
    });
  });

  describe("deleteDataset", () => {
    it("should delete dataset successfully", async () => {
      // Pre-populate store
      store.datasets = [
        {
          id: "1",
          name: "Dataset 1",
          slug: "dataset-1",
          fields: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          name: "Dataset 2",
          slug: "dataset-2",
          fields: [],
          createdAt: new Date().toISOString(),
        },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
      } as Response);

      const result = await store.deleteDataset("1");

      expect(result).toBe(true);
      expect(store.datasets).toHaveLength(1);
      expect(store.datasets[0].id).toBe("2");
    });

    it("should clear selectedDataset if deleted was selected", async () => {
      store.datasets = [
        {
          id: "1",
          name: "Dataset 1",
          slug: "dataset-1",
          fields: [],
          createdAt: new Date().toISOString(),
        },
      ];
      store.selectedDataset = store.datasets[0];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
      } as Response);

      await store.deleteDataset("1");

      expect(store.selectedDataset).toBeNull();
    });
  });

  describe("derived state", () => {
    it("should calculate totalCount correctly", () => {
      store.datasets = [
        {
          id: "1",
          name: "Dataset 1",
          slug: "dataset-1",
          fields: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          name: "Dataset 2",
          slug: "dataset-2",
          fields: [],
          createdAt: new Date().toISOString(),
        },
      ];

      expect(store.totalCount).toBe(2);
    });

    it("should sort datasets by name", () => {
      store.datasets = [
        { id: "2", name: "Zebra", slug: "zebra", fields: [], createdAt: new Date().toISOString() },
        { id: "1", name: "Alpha", slug: "alpha", fields: [], createdAt: new Date().toISOString() },
      ];

      expect(store.sortedDatasets[0].name).toBe("Alpha");
      expect(store.sortedDatasets[1].name).toBe("Zebra");
    });

    it("should calculate hasDatasets correctly", () => {
      expect(store.hasDatasets).toBe(false);

      store.datasets = [
        {
          id: "1",
          name: "Dataset 1",
          slug: "dataset-1",
          fields: [],
          createdAt: new Date().toISOString(),
        },
      ];

      expect(store.hasDatasets).toBe(true);
    });
  });
});
