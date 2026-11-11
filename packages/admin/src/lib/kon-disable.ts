/**
 * The question asked before a kon is disabled: it names what goes away.
 *
 * Disabling was a single click with no feedback, and for a core kon (datasets, media,
 * blog…) that click removes a section of the menu other screens rely on. The wording is
 * built here, apart from the view, so it can be tested.
 */
import type { ConfirmOptions } from "$lib/confirm.svelte";
import { t } from "$lib/i18n";

export interface KonLike {
  key: string;
  name: string;
  category?: string;
  enabled?: boolean;
  tables?: string[];
  dependsOn?: string[];
}

/** Enabled kons that declare `kon` as a dependency. */
export function dependentsOf(kon: KonLike, all: KonLike[]): KonLike[] {
  return all.filter((m) => m.key !== kon.key && m.enabled && m.dependsOn?.includes(kon.key));
}

export function isCoreKon(kon: KonLike): boolean {
  return kon.category === "core" || kon.category === "grimoire-core";
}

/** The ConfirmDialog content for disabling `kon`. */
export function disableKonPrompt(kon: KonLike, all: KonLike[] = []): ConfirmOptions {
  const core = isCoreKon(kon);
  const parts = [
    core
      ? t("kons.disableCoreWarning", { name: kon.name })
      : t("kons.disableWarning", { name: kon.name }),
  ];
  const dependents = dependentsOf(kon, all);
  if (dependents.length > 0) {
    parts.push(t("kons.disableDependents", { names: dependents.map((d) => d.name).join(", ") }));
  }
  const tables = kon.tables ?? [];
  parts.push(
    tables.length > 0
      ? t("kons.disableKeepsTables", { tables: tables.join(", ") })
      : t("kons.disableKeepsData")
  );
  return {
    title: core
      ? t("kons.disableCoreTitle", { name: kon.name })
      : t("kons.disableTitle", { name: kon.name }),
    description: parts.join(" "),
    confirmLabel: core ? t("kons.disableCoreConfirm") : t("kons.disable"),
    variant: "danger",
  };
}
