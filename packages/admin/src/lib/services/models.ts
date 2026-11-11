/**
 * The models (defineModel) the mounted kons expose: GET /api/models, asked once per page
 * load and shared by the Models pages and the command palette.
 */
import type { ModelDescriptor } from "@kitsuden/shared";

import { api } from "$lib/api";

export interface MountedModel {
  kon: string;
  mountPath: string;
  /** The collection route (`/api/notas/notes`). */
  base: string;
  descriptor: ModelDescriptor;
}

let pending: Promise<MountedModel[]> | null = null;

export function listModels({ fresh = false } = {}): Promise<MountedModel[]> {
  if (fresh) pending = null;
  pending ??= api
    .get<{ data: MountedModel[] }>("/api/models")
    .then((r) => r.data ?? [])
    .catch((e) => {
      pending = null; // a failure is not remembered: the next caller asks again
      throw e;
    });
  return pending;
}

/** `<kon>/<name>`: how a model is named in a URL. */
export const modelKey = (m: MountedModel): string => `${m.kon}/${m.descriptor.name}`;
export const modelPath = (m: MountedModel): string =>
  `/models/${encodeURIComponent(m.kon)}/${encodeURIComponent(m.descriptor.name)}`;

export async function findModel(kon: string, name: string): Promise<MountedModel | null> {
  const models = await listModels();
  return models.find((m) => m.kon === kon && m.descriptor.name === name) ?? null;
}
