/**
 * The logic of DynamicForm, apart from its markup so it can be tested.
 *
 * The form used to know ten field types while the schema builder offers seventeen: a
 * long-text, date & time, file, multi-select, KPI or repeater field simply did not appear
 * in the entry form, with no notice. `controlFor` maps EVERY type of the shared registry
 * to a control, and anything it does not know to "unknown", which the form renders as a
 * visible "cannot be edited here" row instead of nothing.
 */
import { FIELD_TYPES, FIELD_TYPE_ALIASES } from "@kitsuden/shared";

import { t } from "$lib/i18n";

import type { FieldDefinition } from "../../../types/datasets";

export type FieldControl =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "image"
  | "media"
  | "url"
  | "email"
  | "select"
  | "multiselect"
  | "json"
  | "richtext"
  | "relation"
  | "kpi"
  | "repeater"
  | "unknown";

/** A field as the form needs it: a full field or a repeater's subfield. */
export type FormField = Omit<FieldDefinition, "type" | "subFields"> & {
  type: string;
  subFields?: FormField[];
};

/** The control that edits `type`. Aliases (`string`, `file`, `timestamp`…) resolve; the rest is "unknown". */
export function controlFor(type: string | null | undefined): FieldControl {
  if (!type) return "unknown";
  if (Object.hasOwn(FIELD_TYPES, type)) return type as FieldControl;
  // `hasOwn`, not a plain lookup: "toString" is a key of every object, not a field type.
  return Object.hasOwn(FIELD_TYPE_ALIASES, type)
    ? ((FIELD_TYPE_ALIASES as Record<string, string>)[type] as FieldControl)
    : "unknown";
}

/** Every control the form renders for a registry type: none of them may be "unknown". */
export const REGISTRY_CONTROLS = Object.keys(FIELD_TYPES).map((type) => controlFor(type));

/** The value a field starts with when the entry has none. */
export function emptyValue(field: FormField): unknown {
  const control = controlFor(field.type);
  const def = field.defaultValue;
  if (def !== undefined && def !== "") {
    if (control === "number") return Number(def) || 0;
    if (control === "boolean") return def === "true";
    if (control === "multiselect")
      return def
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (control !== "repeater" && control !== "kpi") return def;
  }
  if (control === "boolean") return false;
  if (control === "multiselect" || control === "repeater") return [];
  if (control === "relation" && field.relation?.type !== "one-to-one") return [];
  return null;
}

/** The form's starting data: the entry's value when it has one, the field's default otherwise. */
export function initialValues(
  fields: FormField[],
  initialData: Record<string, unknown> = {}
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    data[field.key] =
      initialData[field.key] !== undefined ? initialData[field.key] : emptyValue(field);
  }
  return data;
}

/** A new, empty row for a repeater. */
export function emptyRow(field: FormField): Record<string, unknown> {
  return initialValues(field.subFields ?? []);
}

/**
 * An ISO date (or anything `Date` parses) as the value of `<input type="datetime-local">`:
 * local time, minutes precision. "" when there is nothing or it does not parse.
 */
export function toDatetimeLocal(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  // Already local and without zone: keep what the user typed.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return text.slice(0, 16);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** The value of a datetime-local input as an ISO timestamp (null when empty or invalid). */
export function fromDatetimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `YYYY-MM-DD` for `<input type="date">`, from a date or a timestamp. */
export function toDateInput(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** One field's error, or null. `rows` errors of a repeater come back as `key.index.subKey`. */
function validateOne(field: FormField, val: unknown, errors: Record<string, string>, path: string) {
  const control = controlFor(field.type);
  // A calculated or unknown field is not the user's to fill in.
  if (control === "kpi" || control === "unknown") return;

  if (field.isRequired && isEmpty(val)) {
    errors[path] = Array.isArray(val)
      ? t("dynamicForm.requiresSelection", { label: field.label })
      : t("dynamicForm.isRequired", { label: field.label });
    return;
  }
  // An empty repeater still has a minimum number of rows to meet.
  if (isEmpty(val) && control !== "repeater") return;

  switch (control) {
    case "number": {
      const num = Number(val);
      if (Number.isNaN(num)) errors[path] = t("dynamicForm.mustBeAValidNumber");
      else if (field.minValue !== undefined && num < field.minValue)
        errors[path] = t("dynamicForm.minimumValueIs", { minValue: field.minValue });
      else if (field.maxValue !== undefined && num > field.maxValue)
        errors[path] = t("dynamicForm.maximumValueIs", { maxValue: field.maxValue });
      break;
    }
    case "text":
    case "textarea":
    case "richtext": {
      const str = String(val);
      if (field.minLength && str.length < field.minLength)
        errors[path] = t("dynamicForm.minimumCharacters", { minLength: field.minLength });
      else if (field.maxLength && str.length > field.maxLength)
        errors[path] = t("dynamicForm.maximumCharacters", { maxLength: field.maxLength });
      else if (field.validationRegex) {
        try {
          if (!new RegExp(field.validationRegex).test(str))
            errors[path] = t("dynamicForm.doesNotMatchPattern", {
              validationRegex: field.validationRegex,
            });
        } catch {
          /* a broken pattern in the schema must not block the entry */
        }
      }
      break;
    }
    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val)))
        errors[path] = t("dynamicForm.invalidEmailAddress");
      break;
    case "url":
      try {
        new URL(String(val));
      } catch {
        errors[path] = t("dynamicForm.invalidUrl");
      }
      break;
    case "json":
      if (typeof val === "string") {
        try {
          JSON.parse(val);
        } catch {
          errors[path] = t("dynamicForm.invalidJson");
        }
      }
      break;
    case "select": {
      const valid = (field.options || []).map((o) => o.value);
      if (!valid.includes(String(val))) errors[path] = t("dynamicForm.invalidSelection");
      break;
    }
    case "multiselect": {
      const valid = new Set((field.options || []).map((o) => o.value));
      const chosen = Array.isArray(val) ? val : [val];
      if (chosen.some((v) => !valid.has(String(v))))
        errors[path] = t("dynamicForm.invalidSelection");
      break;
    }
    case "date":
    case "datetime":
      if (Number.isNaN(new Date(String(val)).getTime()))
        errors[path] = t("dynamicForm.invalidDate");
      break;
    case "repeater": {
      const rows = Array.isArray(val) ? (val as Array<Record<string, unknown>>) : [];
      if (field.minLength && rows.length < field.minLength)
        errors[path] = t("dynamicForm.minimumRows", { minLength: field.minLength });
      else if (field.maxLength && rows.length > field.maxLength)
        errors[path] = t("dynamicForm.maximumRows", { maxLength: field.maxLength });
      rows.forEach((row, i) => {
        for (const sub of field.subFields ?? [])
          validateOne(sub, row?.[sub.key], errors, `${path}.${i}.${sub.key}`);
      });
      break;
    }
    default:
      break;
  }
}

/** Errors by field key (`key`, or `key.<row>.<subKey>` inside a repeater). Empty = valid. */
export function validateFields(
  fields: FormField[],
  data: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) validateOne(field, data[field.key], errors, field.key);
  return errors;
}

function cleanOne(field: FormField, val: unknown): unknown {
  const control = controlFor(field.type);
  if (control === "number" && val !== null && val !== undefined && val !== "") return Number(val);
  if (control === "json" && typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  if (control === "repeater" && Array.isArray(val)) {
    return (val as Array<Record<string, unknown>>).map((row) => {
      const out: Record<string, unknown> = {};
      for (const sub of field.subFields ?? []) out[sub.key] = cleanOne(sub, row?.[sub.key]);
      return out;
    });
  }
  return val;
}

/** What the form submits: one value per field, numbers as numbers and JSON parsed. */
export function cleanValues(
  fields: FormField[],
  data: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.key] = cleanOne(field, data[field.key]);
  return out;
}

/** The last path segment of a URL, to show a file by its name. */
export function fileNameOf(value: unknown): string {
  const text = String(value ?? "");
  const last = text.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? text;
  try {
    return decodeURIComponent(last) || text;
  } catch {
    // A stray "%" in a file name is not an encoding.
    return last || text;
  }
}
