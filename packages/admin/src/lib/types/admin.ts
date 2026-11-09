/**
 * Admin Configuration Types
 * Django-style admin configuration for Grimoires
 */

export interface AdminConfig {
  /** Display name in admin */
  name: string;

  /** Singular name for buttons (e.g., "Add Product") */
  singularName?: string;

  /** Icon name from Lucide */
  icon?: string;

  /** Order in sidebar (lower = first) */
  order?: number;

  /** Category in sidebar */
  category?: "core" | "content" | "data" | "esports";

  /** Main views for this grimoire */
  views: AdminView[];

  /**
   * Id of the view that opens by default.
   *
   * Declared by the manifests (`admin.defaultView` in `kon.json`) and
   * returned by `/api/admin/registry` all along; it was missing only from this type, and
   * so the panel could not use it without TypeScript complaining. The
   * practical result was that a kon opened its first tab instead of the one it
   * declared.
   */
  defaultView?: string;

  /** Custom form configurations */
  forms?: Record<string, FormConfig>;

  /** Override default API endpoint */
  apiEndpoint?: string;

  /** Custom Svelte components (optional) */
  components?: {
    /** Override the entire view */
    view?: string;
    /** Custom form component */
    form?: string;
    /** Custom detail view */
    detail?: string;
    /** Custom dashboard widget */
    dashboard?: string;
  };
}

export type AdminView =
  | GridView
  | KanbanView
  | CalendarView
  | DashboardView
  | FormView
  | CustomView;

interface BaseView {
  id: string;
  title: string;
  icon?: string;
  /** Permissions required */
  permissions?: string[];
}

export interface GridView extends BaseView {
  type: "grid";
  /** Table to display */
  table: string;
  /** Columns to show */
  columns?: TableColumn[];
  /** Default sort */
  defaultSort?: { column: string; direction: "asc" | "desc" };
  /** Filters available */
  filters?: FilterConfig[];
  /** Bulk actions */
  bulkActions?: BulkAction[];
  /** Row actions */
  actions?: ("view" | "edit" | "delete" | "clone")[];
  /** Custom row actions (approve, decline, publish, etc.) */
  rowActions?: RowAction[];
}

export interface KanbanView extends BaseView {
  type: "kanban";
  table: string;
  /** Field to group by (status, stage, etc) */
  groupBy: string;
  /** Columns to show in cards */
  cardFields?: string[];
  /** Allow drag-drop reordering */
  draggable?: boolean;
}

export interface CalendarView extends BaseView {
  type: "calendar";
  table: string;
  /** Date field for calendar */
  dateField: string;
  /** Title field for events */
  titleField: string;
  /** Enable drag to reschedule */
  editable?: boolean;
}

export interface DashboardView extends BaseView {
  type: "dashboard";
  /** Widgets to display */
  widgets: DashboardWidget[];
}

export interface FormView extends BaseView {
  type: "form";
  /** For creating/editing records */
  mode: "create" | "edit";
  table: string;
  /** Field configuration */
  fields: FormField[];
  /** Layout: tabs, sections, or flat */
  layout?: "tabs" | "sections" | "flat";
  /** Tab/section definitions */
  groups?: FieldGroup[];
}

export interface CustomView extends BaseView {
  type: "custom";
  /** Name of exported Svelte component */
  component: string;
  /** Props to pass to component */
  props?: Record<string, any>;
}

export interface TableColumn {
  name: string;
  label?: string;
  type?: "text" | "number" | "date" | "datetime" | "boolean" | "image" | "json" | "relation";
  width?: string;
  sortable?: boolean;
  filterable?: boolean;
  hidden?: boolean;
  /** Format as badge with colors */
  badge?: boolean;
  badgeColor?: Record<string, string>;
  /** For relations: show this field instead of ID */
  displayField?: string;
}

export interface FilterConfig {
  field: string;
  type: "text" | "number" | "date" | "select" | "boolean" | "multiselect";
  label?: string;
  options?: { value: string; label: string }[];
  /** For date filters */
  presets?: ("today" | "week" | "month" | "year")[];
}

export interface RowAction {
  id: string;
  label: string;
  icon?: string;
  variant?: "default" | "primary" | "success" | "warning" | "danger";
  /** Only show if field has this value */
  showIf?: { field: string; equals: any };
  /** API endpoint suffix — called as POST {base}/{id}/{endpoint} */
  endpoint?: string;
  /** Confirmation message before executing */
  confirm?: string;
  /** Refresh data after action */
  refresh?: boolean;
}

export interface BulkAction {
  id: string;
  label: string;
  icon?: string;
  /** API endpoint to call */
  endpoint?: string;
  /** Confirmation message */
  confirm?: string;
  /** Refresh after action */
  refresh?: boolean;
}

export interface DashboardWidget {
  id: string;
  type: "stat" | "chart" | "list" | "recent" | "custom";
  title: string;
  /** Position in grid */
  position?: { x: number; y: number; w: number; h: number };

  // For stat widget
  table?: string;
  aggregation?: "count" | "sum" | "avg" | "min" | "max";
  field?: string;
  filter?: Record<string, any>;

  // For chart widget
  chartType?: "line" | "bar" | "pie" | "doughnut";
  xAxis?: string;
  yAxis?: string;

  // For list widget
  columns?: string[];
  limit?: number;

  // For custom widget
  component?: string;
}

export interface FormConfig {
  layout?: "tabs" | "sections" | "flat";
  groups?: FieldGroup[];
  fields?: FormField[];
}

export interface FieldGroup {
  id: string;
  label: string;
  icon?: string;
  fields: string[];
}

export interface FormField {
  name: string;
  label?: string;
  type?:
    | "text"
    | "textarea"
    | "number"
    | "date"
    | "datetime"
    | "boolean"
    | "select"
    | "multiselect"
    | "relation"
    | "image"
    | "file"
    | "json"
    | "richtext"
    | "code";
  required?: boolean;
  placeholder?: string;
  helpText?: string;

  // For selects
  options?: { value: string; label: string }[];

  // For relations
  relation?: {
    table: string;
    displayField: string;
    valueField?: string;
  };

  // Validation
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    email?: boolean;
    url?: boolean;
  };

  // Conditional display
  showIf?: { field: string; equals: any };
}

// Schema types for auto-generation
export interface SchemaColumn {
  name: string;
  type: string;
  label?: string;
  nullable: boolean;
  default?: any;
  isPrimary?: boolean;
  isForeign?: boolean;
  relatedTable?: string;
}

export interface InlineRelationConfig {
  table: string;
  fkColumn: string;
  title: string;
  /** Which columns to show in the inline grid */
  columns?: string[];
}

export interface TableSchema {
  name: string;
  columns: SchemaColumn[];
  primaryKey: string;
  relations?: {
    column: string;
    table: string;
    displayField: string;
  }[];
}
