/**
 * The storage form binds one input per provider field. The API leaves out
 * secrets and empty fields, and binding an input to `undefined` makes Svelte 5
 * throw `props_invalid_value`, which broke the whole Media › Settings tab.
 */
export interface StorageField {
  key: string;
  type: string;
}

export interface StorageProvider {
  id: string;
  fields: StorageField[];
}

/** Gives every field of the storage's provider a value: "" or, for a checkbox, false. */
export function withFieldDefaults<T extends { provider?: string }>(
  storage: T,
  providers: StorageProvider[]
): T {
  const provider = providers.find((p) => p.id === storage?.provider);
  if (!provider) return storage;
  const filled: Record<string, unknown> = { ...storage };
  for (const field of provider.fields) {
    if (filled[field.key] === undefined || filled[field.key] === null) {
      filled[field.key] = field.type === "checkbox" ? false : "";
    }
  }
  return filled as T;
}

/**
 * The reverse, before saving: the "" added above are not values, and the API
 * validates `publicUrl` as a URL, so it would reject "".
 */
export function withoutEmptyFields<T extends object>(storage: T): T {
  return Object.fromEntries(Object.entries(storage ?? {}).filter(([, v]) => v !== "")) as T;
}
