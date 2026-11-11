/** A dataset with its schema, as the entry pages need it (GET /api/datasets/:id). */
import { api } from "$lib/api";

import type { FieldDefinition } from "../../types/datasets";

import type { DatasetLike } from "./source";

export async function loadDataset(id: string): Promise<DatasetLike> {
  const d = await api.get<DatasetLike & { fields?: FieldDefinition[]; schema?: FieldDefinition[] }>(
    `/api/datasets/${encodeURIComponent(id)}`
  );
  // The API calls the fields `schema`; the shared type, `fields`.
  const schema = Array.isArray(d.schema) ? d.schema : Array.isArray(d.fields) ? d.fields : [];
  return { ...d, schema };
}
