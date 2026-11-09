/**
 * DataSets — input and output schemas of its operations (kon SDK)
 * ============================================================================
 *
 * The OpenAPI and the MCP tools of `/api/datasets` come from here.
 *
 * Write INPUTS are loose on purpose (everything optional and
 * `passthrough`): in this kon authorization depends on the DATASET (its
 * `policyJson`) and on the entry (its owner), so it is decided in the handler
 * after loading them (`permission.policy.inHandler`). If the schema required fields,
 * a request without permission would get a 422 instead of its 401/403/404, and would reveal
 * more than it should. The 400s with their own message stay in the handler.
 */
import { z } from "zod";

import { createCalculatedFieldSchema, updateCalculatedFieldSchema } from "./datasets.calculated";
import { exportConfigSchema, importConfigSchema } from "./datasets.import-export";
import { indexConfigSchema } from "./datasets.indexes";

const servedDate = () => z.string().datetime({ offset: true });
const free = () => z.unknown().optional();

export const ParamId = z.object({
  id: z.string().describe("Dataset id (uuid; anything else is a 404)"),
});
export const ParamSlug = z.object({ slug: z.string() });
export const InputParam = z.object({
  id: z.string().describe("Dataset id (uuid)"),
  entryId: z.string().describe("Entry id (uuid)"),
});
export const FieldParam = z.object({
  id: z.string().describe("Dataset id (uuid)"),
  fieldId: z.string().describe("Calculated field id (uuid)"),
});

export const LimitQuery = z
  .object({ limit: z.string().optional().describe("1-200, default 50") })
  .passthrough();

export const InputsQuery = z
  .object({
    limit: z.string().optional().describe("1-1000, default 500"),
    status: z.string().optional(),
    includeCalculated: z.enum(["true", "false"]).optional(),
    calculatedFields: z.string().optional().describe("Comma-separated calculated field names"),
    includeThumbnailUrl: z.enum(["true", "false"]).optional(),
  })
  .passthrough();

export const InputQuery = z
  .object({ includeThumbnailUrl: z.enum(["true", "false"]).optional() })
  .passthrough();

export const SearchQuery = z
  .object({
    q: z.string().optional().describe("Full-text query"),
    filters: z
      .string()
      .optional()
      .describe("field:value, field:min..max; comma-separated (max 20)"),
    facets: z.string().optional().describe("Comma-separated fields to count (max 8)"),
    status: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .passthrough();

/** A dataset as it comes in (create or edit). */
export const DatasetEntry = z
  .object({
    name: z.string().optional().describe("Required when creating, max 200 chars"),
    slug: z.string().optional().describe("a-z, 0-9 and dashes; derived from the name when missing"),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    schema: z.array(z.record(z.string(), z.unknown())).optional().describe("Field definitions"),
    fields: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Alias of `schema` (what the panel sends)"),
    displayConfig: free(),
    policyJson: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Who reads and writes (admin only)"),
    workflowJson: free(),
    contentConfig: free(),
    sourceName: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    sourceLicense: z.string().nullable().optional(),
    sourceVersion: z.string().nullable().optional(),
    sourceCaveats: z.string().nullable().optional(),
  })
  .passthrough()
  .optional();

/** An entry as it comes in. Editorial fields (status, order, owner) are written only by the team. */
export const InputInput = z
  .object({
    title: z.string().optional(),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The entry fields, as defined by the dataset schema"),
    status: z.string().optional().describe("staff only"),
    sortOrder: z.number().optional().describe("staff only"),
    thumbnailId: z.string().nullable().optional().describe("staff only, media uuid"),
    ownerId: z.string().nullable().optional().describe("staff only"),
  })
  .passthrough();

export const InputsInput = z
  .union([InputInput, z.array(InputInput).describe("Bulk: 1-1000 entries")])
  .optional();

// What the handler REALLY requires (before, `partial().optional()`: a body
// without `datasets` passed the SDK and the handler's `parse` turned it into a 500;
// found by Schemathesis). Nothing that used to work is rejected.
export const Export = exportConfigSchema.passthrough();
export const Import = z
  .object({
    datasetId: z.string().min(1),
    data: z.array(z.record(z.string(), z.unknown())),
    config: importConfigSchema.partial().optional(),
  })
  .passthrough();
export const ImportPackage = z
  .object({
    package: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("An export package (with `datasets`)"),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .optional();
export const SnapshotManual = z
  .object({
    reason: z.string().optional(),
    calculatedValues: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .optional();
export const Restore = z
  .object({ timestamp: z.string().optional().describe("Snapshot timestamp to restore") })
  .passthrough()
  .optional();
export const CompareSnapshots = z
  .object({ snapshot1: free(), snapshot2: free() })
  .passthrough()
  .optional();
export const CompareInputs = z
  .object({ entryIds: z.array(z.string()).optional().describe("2-8 entry uuids") })
  .passthrough()
  .optional();
export const ApplyIndexes = z
  .object({ config: indexConfigSchema.partial().optional() })
  .passthrough()
  .optional();
export const IndicesAuto = z
  .object({ minConfidence: z.enum(["high", "medium"]).optional() })
  .passthrough()
  .optional();

export const ComputedFieldInput = createCalculatedFieldSchema
  .omit({ dataSetId: true })
  .partial()
  .passthrough()
  .optional();
export const ComputedFieldChanges = updateCalculatedFieldSchema.partial().passthrough().optional();

// ── Outputs ──────────────────────────────────────────────────────────────────

export const Dataset = z
  .object({
    id: z.guid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    schema: z.unknown().describe("Field definitions (array, or legacy {fields})"),
    policyJson: z.record(z.string(), z.unknown()).nullable(),
    createdAt: servedDate().nullable(),
    updatedAt: servedDate().nullable(),
  })
  .passthrough();

export const DatasetsList = z.object({ docs: z.array(Dataset), totalDocs: z.number().int() });

export const Input = z
  .object({
    id: z.guid(),
    dataSetId: z.guid(),
    title: z.string(),
    data: z.record(z.string(), z.unknown()),
    status: z.string(),
    sortOrder: z.number(),
    ownerId: z.string().nullable(),
    thumbnailUrl: z.string().optional(),
    createdAt: servedDate().nullable(),
    updatedAt: servedDate().nullable(),
  })
  .passthrough();

export const EntriesList = z.object({
  docs: z.array(
    Input.extend({ _calculated: z.record(z.string(), z.unknown()).optional() }).passthrough()
  ),
  totalDocs: z.number().int(),
  calculatedFields: z.array(z.record(z.string(), z.unknown())).optional(),
  dataset: z.object({ id: z.guid(), name: z.string(), slug: z.string() }),
});

export const InputOrInputs = z.union([Input, z.array(Input)]);

// What `searchEntries` returns (SearchResult): `data`/`total` and the
// facets as a LIST. Before, `docs`/`totalDocs` and an object were declared; it was not
// noticed because search never got as far as responding (Schemathesis).
export const Search = z
  .object({
    data: z.array(Input),
    total: z.number().int(),
    facets: z.array(
      z.object({
        field: z.string(),
        values: z.array(z.object({ value: z.string(), count: z.number().int() })),
      })
    ),
    provenance: z.record(z.string(), z.unknown()).nullable(),
  })
  .passthrough();

export const Comparison = z.object({
  data: z.array(z.object({ id: z.guid(), title: z.string() })),
  differences: z.unknown(),
});

export const Generic = z
  .record(z.string(), z.unknown())
  .describe("Result object (see the description)");
export const Success = z.object({ success: z.literal(true) }).passthrough();

export const ComputedField = z
  .object({ id: z.guid(), name: z.string(), label: z.string(), type: z.string() })
  .passthrough();
export const ComputedFieldsList = z.object({
  success: z.literal(true),
  fields: z.array(ComputedField),
});
export const ComputedFieldOutput = z.object({ success: z.literal(true), field: ComputedField });
