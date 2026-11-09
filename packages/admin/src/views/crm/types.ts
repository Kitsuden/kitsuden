/**
 * CRM View Types
 */

export interface CRMStats {
  contacts: number;
  companies: number;
  deals: {
    total: number;
    open: number;
    won: number;
    lost: number;
    values: {
      total: number;
      open: number;
      won: number;
    };
  };
  activities: {
    total: number;
    overdue: number;
  };
}

export interface CrmContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  mobile?: string;
  jobTitle?: string;
  department?: string;
  avatar?: string;
  status: "lead" | "prospect" | "customer" | "churned" | "archived";
  source?: string;
  score: number;
  companyId?: string;
  company?: CrmCompany;
  assignedTo?: string;
  linkedin?: string;
  twitter?: string;
  address?: string;
  city?: string;
  country?: string;
  notes?: string;
  tags: string[];
  customFields: Record<string, unknown>;
  lastContactedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmCompany {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  size?: string;
  website?: string;
  email?: string;
  linkedinUrl?: string;
  twitterHandle?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  description?: string;
  logo?: string;
  annualRevenue?: number;
  employeeCount?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CrmPipeline {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  currency: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CrmPipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  color: string;
  order: number;
  probability: number;
  wipLimit?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CrmDeal {
  id: string;
  title: string;
  description?: string;
  value: number;
  currency: string;
  status: "open" | "won" | "lost" | "paused";
  priority?: "low" | "medium" | "high";
  pipelineId: string;
  pipeline?: CrmPipeline;
  stageId: string;
  stage?: CrmPipelineStage;
  probability: number;
  contactId?: string;
  contact?: CrmContact;
  companyId?: string;
  company?: CrmCompany;
  assignedTo?: string;
  expectedCloseDate?: string;
  actualCloseDate?: string;
  lastActivityAt?: string;
  source?: string;
  campaign?: string;
  tags: string[];
  customFields: Record<string, unknown>;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivity {
  id: string;
  type: "call" | "email" | "meeting" | "task" | "note" | "sms" | "demo";
  subject: string;
  description?: string;
  contactId?: string;
  contact?: CrmContact;
  companyId?: string;
  company?: CrmCompany;
  dealId?: string;
  deal?: CrmDeal;
  assignedTo?: string;
  createdBy?: string;
  dueDate?: string;
  completedAt?: string;
  durationMinutes?: number;
  outcome?: string;
  notes?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanData {
  pipeline: CrmPipeline;
  stages: (CrmPipelineStage & { deals: CrmDeal[] })[];
}

// ============================================================================
// PHASE 1: CRM BUILDER TYPES
// ============================================================================

export interface EntityFieldSchema {
  key: string;
  type:
    | "text"
    | "number"
    | "currency"
    | "date"
    | "datetime"
    | "select"
    | "multiselect"
    | "boolean"
    | "email"
    | "url"
    | "file"
    | "contact"
    | "company";
  label: string;
  required?: boolean;
  unique?: boolean;
  options?: string[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
  calendarSync?: boolean;
  reminderDays?: number[];
}

export interface StageEntryRequirements {
  requiredFields?: string[];
  requiredDocuments?: string[];
  customValidations?: {
    field: string;
    operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "exists";
    value?: unknown;
  }[];
}

export interface StageAction {
  type:
    | "create_calendar_event"
    | "send_email"
    | "create_task"
    | "create_activity"
    | "webhook"
    | "log_time"
    | "update_field";
  template?: string;
  title?: string;
  url?: string;
  field?: string;
  value?: unknown;
  condition?: {
    field: string;
    operator: string;
    value: unknown;
  };
}

export interface CrmEntityConfig {
  id: string;
  grimoireId: string;
  entityName: string;
  singularLabel: string;
  pluralLabel: string;
  requiresContact: boolean;
  requiresCompany: boolean;
  allowsValue: boolean;
  allowsTimeTracking: boolean;
  fieldSchema: EntityFieldSchema[];
  defaultPipelineId?: string;
  isActive: boolean;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface CrmPipelineStageExtended extends CrmPipelineStage {
  trackTimeInStage: boolean;
  estimatedDays: number | null;
  entryRequirements: StageEntryRequirements;
  onEnterActions: StageAction[];
  onExitActions: StageAction[];
}

export interface DealTimelineEntry {
  id: string;
  from_stage_id: string | null;
  from_stage_name: string | null;
  to_stage_id: string;
  to_stage_name: string;
  entered_at: string;
  exited_at: string | null;
  duration_minutes: number | null;
  duration_text: string;
  was_on_time: boolean | null;
  sla_breach: boolean;
  moved_by: string | null;
}

export interface ValidationResult {
  canMove: boolean;
  missingFields: {
    key: string;
    label: string;
    currentValue: unknown;
  }[];
  missingDocuments: {
    type: string;
    label: string;
  }[];
  failedValidations: {
    field: string;
    operator: string;
    expected: unknown;
    actual: unknown;
    message: string;
  }[];
  warnings: string[];
}

export interface StageCycleTime {
  stage_id: string;
  stage_name: string;
  avg_duration_minutes: number;
  avg_duration_text: string;
  median_duration_minutes: number;
  median_duration_text: string;
  min_duration_minutes: number;
  min_duration_text: string;
  max_duration_minutes: number;
  max_duration_text: string;
  deal_count: number;
  sla_breach_count: number;
  sla_breach_rate: number;
}
