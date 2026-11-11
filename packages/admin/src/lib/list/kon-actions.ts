/**
 * The row and bulk actions a kon declares for a view (`rowActions`, `bulkActions` in its
 * manifest), as actions of the list template. A row action calls
 * POST <endpoint>/<id>/<action.endpoint>; a bulk action calls its endpoint with the ids.
 */
import { api } from "$lib/api";
import { explorerEndpoint } from "$lib/explorer-endpoint";
import type { GridView } from "$lib/types/admin";

import type { BulkAction, RowAction, Row } from "./source";

export function konViewActions(
  view: Pick<GridView, "rowActions" | "bulkActions">,
  apiEndpoint: string | undefined,
  table: string
): { rowActions?: RowAction[]; bulkActions?: BulkAction[] } {
  const endpoint = explorerEndpoint(apiEndpoint, table);
  const rowActions = (view.rowActions ?? [])
    .filter((a) => a.endpoint)
    .map<RowAction>((a) => ({
      id: a.id,
      label: a.label,
      confirm: a.confirm,
      danger: a.variant === "danger",
      visible: a.showIf ? (row: Row) => row[a.showIf!.field] === a.showIf!.equals : undefined,
      run: async (row: Row) => {
        await api.post(`${endpoint}/${String(row.id)}/${a.endpoint}`);
      },
    }));
  const bulkActions = (view.bulkActions ?? [])
    .filter((a) => a.endpoint)
    .map<BulkAction>((a) => ({
      id: a.id,
      label: a.label,
      confirm: a.confirm,
      run: async (ids: string[]) => {
        const target = a.endpoint!.startsWith("/") ? a.endpoint! : `${endpoint}/${a.endpoint}`;
        await api.post(target, { ids });
      },
    }));
  return {
    rowActions: rowActions.length > 0 ? rowActions : undefined,
    bulkActions: bulkActions.length > 0 ? bulkActions : undefined,
  };
}
