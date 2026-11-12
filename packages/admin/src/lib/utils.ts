import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { localeFormat } from "$lib/i18n";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(
  date: string | Date | undefined,
  style: "short" | "long" = "short"
): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(localeFormat(), {
    year: "numeric",
    month: style === "long" ? "long" : "short",
    day: "numeric",
  });
}

/**
 * A moment as the panel writes it everywhere ("Nov 12, 2026, 3:06 PM"): medium date and
 * short time in the panel's language. "—" when there is none.
 */
export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(localeFormat(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString(localeFormat());
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "…";
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
