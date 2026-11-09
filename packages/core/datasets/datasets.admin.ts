/**
 * DataSets Admin Configuration
 *
 * Core kon admin config for DataSets management.
 * Positioned first in the sidebar (order: 0).
 */

// Local type definition to avoid importing from packages/admin
interface AdminViewColumn {
  name: string;
  type: string;
  label?: string;
  hidden?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  displayField?: string;
  badgeColor?: Record<string, string>;
}

interface AdminView {
  id: string;
  type: string;
  title: string;
  table: string;
  columns: AdminViewColumn[];
  defaultSort?: { column: string; direction: "asc" | "desc" };
  actions?: string[];
  bulkActions?: Array<{
    id: string;
    label: string;
    icon: string;
    confirm?: string;
    refresh?: boolean;
  }>;
  filters?: Array<{
    field: string;
    type: string;
    label: string;
    options?: string[];
    table?: string;
  }>;
}

interface AdminConfig {
  name: string;
  singularName: string;
  icon: string;
  category: string;
  order: number;
  views: AdminView[];
  forms?: Record<string, unknown>;
  apiEndpoint: string;
}

export const adminConfig: AdminConfig = {
  name: "DataSets",
  singularName: "DataSet",
  icon: "Database",
  category: "core",
  order: 0, // First in sidebar

  views: [
    {
      id: "list",
      type: "grid",
      title: "All DataSets",
      table: "data_sets",
      columns: [
        { name: "id", type: "text", label: "ID", hidden: true },
        { name: "name", type: "text", label: "Name", sortable: true, filterable: true },
        { name: "slug", type: "text", label: "Slug", sortable: true },
        { name: "description", type: "text", label: "Description" },
        { name: "icon", type: "text", label: "Icon" },
        { name: "created_at", type: "datetime", label: "Created", sortable: true },
        { name: "updated_at", type: "datetime", label: "Updated", sortable: true },
      ],
      defaultSort: { column: "name", direction: "asc" },
      actions: ["view", "edit", "delete"],
      bulkActions: [
        {
          id: "delete",
          label: "Delete",
          icon: "Trash2",
          confirm: "Delete {count} datasets?",
          refresh: true,
        },
      ],
    },
    {
      id: "entries",
      type: "grid",
      title: "Entries Explorer",
      table: "data_entries",
      columns: [
        { name: "id", type: "text", hidden: true },
        { name: "title", type: "text", label: "Title", sortable: true, filterable: true },
        { name: "data_set_id", type: "relation", label: "DataSet", displayField: "name" },
        {
          name: "status",
          type: "badge",
          label: "Status",
          badgeColor: {
            published: "green",
            draft: "yellow",
            archived: "gray",
          },
        },
        { name: "sort_order", type: "number", label: "Order", sortable: true },
        { name: "created_at", type: "datetime", label: "Created", sortable: true },
      ],
      filters: [
        {
          field: "status",
          type: "select",
          label: "Status",
          options: ["published", "draft", "archived"],
        },
        { field: "data_set_id", type: "relation", label: "DataSet", table: "data_sets" },
      ],
      actions: ["view", "edit", "delete"],
    },
  ],

  forms: {
    dataset: {
      layout: "tabs",
      groups: [
        {
          id: "basic",
          label: "Basic Info",
          icon: "Info",
          fields: ["name", "slug", "description", "icon"],
        },
        {
          id: "schema",
          label: "Schema",
          icon: "Table",
          fields: ["schema"],
          component: "SchemaBuilder", // Custom component for field definition
        },
        {
          id: "security",
          label: "Security",
          icon: "Shield",
          fields: ["policy_json"],
        },
        {
          id: "display",
          label: "Display",
          icon: "Layout",
          fields: ["display_config"],
        },
      ],
    },
  },

  apiEndpoint: "/api/datasets",
};

// Sidebar configuration for Core kons
export const sidebarConfig = {
  id: "datasets",
  label: "DataSets",
  icon: "Database",
  href: "/admin/datasets",
  order: 0, // First position
  category: "core",
  badge: {
    text: "Core",
    variant: "default",
  },
};

export default adminConfig;
