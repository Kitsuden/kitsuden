/**
 * The history of a record, mapped from what the API keeps about it:
 *
 *   - its change history (GET …/entries/:entryId/history for a dataset entry,
 *     GET /api/history/:table/:id for a table row): who created, changed or
 *     deleted it, a person or an agent, and the fields that changed;
 *   - the row's own timestamps (created, last updated, and by whom when the row says so),
 *     for what happened before the change history existed;
 *   - a dataset entry's snapshots (GET /api/datasets/:id/entries/:entryId/snapshots), each
 *     compared with the one before it;
 *   - the approval proposals that targeted the record (GET /api/approvals/proposals, matched
 *     by the API path they would call): which agent asked, what it would change, and which
 *     person approved or rejected it.
 *
 * A record changed before the change history existed shows only what the rest keeps, and
 * the page says so rather than inventing entries.
 */

/** tallao's DiffChange. */
export interface Change {
  field: string;
  label?: string;
  before?: unknown;
  after?: unknown;
  /** A secret field: it changed and its values were never kept (DiffView shows "hidden"). */
  redacted?: boolean;
}

/** A value the API cut because it was too long: `{ truncated: true, bytes, preview }`. */
const isCut = (v: unknown): v is { truncated: true; preview: string; bytes?: number } =>
  !!v &&
  typeof v === "object" &&
  (v as { truncated?: unknown }).truncated === true &&
  typeof (v as { preview?: unknown }).preview === "string";

/**
 * A field the form does not label (a column, a secret, `ownerId`) in words:
 * `api_token` → "Api token", `ownerId` → "Owner id".
 */
export function fieldWords(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * DiffView's `format` for the history: a value the API cut shows its preview with an
 * ellipsis, a timestamp is written as a date; anything else keeps DiffView's own.
 */
export function historyValue(
  value: unknown,
  formatDate?: (iso: string) => string
): string | undefined {
  if (isCut(value)) return `${value.preview.trimEnd()}…`;
  // A timestamp reads as a date, like the rest of the page.
  if (formatDate && typeof value === "string" && ISO_DATE_TIME.test(value)) {
    return formatDate(value);
  }
  return undefined;
}

export type HistoryKind = "created" | "updated" | "snapshot" | "proposal" | "change";

export interface HistoryEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind: HistoryKind;
  /** The person who did it (or who approved it, for an agent's change). */
  actor?: string;
  /** Set when an agent asked for the change. */
  agent?: string;
  /** For a proposal: pending, approved, executed, rejected, failed, expired… */
  status?: string;
  /** The person who decided an agent's proposal. */
  decidedBy?: string;
  /** For a recorded change: what was done to the record. */
  action?: "create" | "update" | "delete";
  /** The system wrote it (no person, no agent). */
  system?: boolean;
  /** The API left some fields out of this change (too many or too large). */
  truncated?: boolean;
  note?: string;
  changes: Change[];
}

export interface SnapshotLike {
  timestamp: string;
  data: Record<string, unknown>;
  meta?: { triggeredBy?: string; reason?: string; source?: string };
}

/** One entry of the API's change history of a record. */
export interface ChangeLike {
  id: string;
  action: "create" | "update" | "delete";
  at: string;
  actor: { type: "user" | "agent" | "system"; id: string | null; name: string | null };
  changes: Array<{ field: string; before?: unknown; after?: unknown; redacted?: boolean }>;
  truncated?: boolean;
  proposalId?: string | null;
  /** The user id of who approved it, when the write was an approved agent proposal. */
  approvedBy?: string | null;
}

export interface ProposalLike {
  id: string;
  status: string;
  method: string;
  path: string;
  createdAt: string;
  decidedAt: string | null;
  executedAt?: string | null;
  comment?: string | null;
  agentName: string | null;
  decidedByName: string | null;
  diff?: {
    kind: string;
    changes?: Array<{ field: string; before?: unknown; after?: unknown }>;
    current?: unknown;
    proposed?: unknown;
  } | null;
  fieldDiff?: {
    target?: { rowId?: string };
    fields?: Array<{ field: string; before?: unknown; after?: unknown }>;
  } | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field changes between two versions of a record (keys starting with `_` are internal). */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  labels: Record<string, string> = {}
): Change[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: Change[] = [];
  for (const field of keys) {
    if (field.startsWith("_")) continue;
    const a = before?.[field];
    const b = after?.[field];
    if (same(a, b)) continue;
    out.push({ field, label: labels[field], before: a ?? null, after: b ?? null });
  }
  return out;
}

/** The path without a trailing slash or query, so `/api/x/1` and `/api/x/1/` match. */
const cleanPath = (path: string) => path.split("?")[0]!.replace(/\/+$/, "");

/**
 * Whether a proposal targets this record: its API path is the record's (both spellings of
 * the datasets base count as one), or its ledger target names the row.
 */
export function proposalTargets(p: ProposalLike, apiPath: string, id: string): boolean {
  if (!id) return false;
  if (p.fieldDiff?.target?.rowId === id) return true;
  const norm = (path: string) => cleanPath(path).replace("/api/data-sets/", "/api/datasets/");
  return norm(p.path) === norm(apiPath);
}

/** What a proposal would change, as field changes (`data.price` is shown as `price`). */
export function proposalChanges(p: ProposalLike, labels: Record<string, string> = {}): Change[] {
  const named = (field: string) => {
    const key = field.replace(/^data\./, "");
    return { field: key, label: labels[key] };
  };
  if (p.fieldDiff?.fields?.length) {
    return p.fieldDiff.fields.map((f) => ({
      ...named(f.field),
      before: f.before ?? null,
      after: f.after ?? null,
    }));
  }
  const diff = p.diff;
  if (!diff) return [];
  if (diff.changes?.length) {
    return diff.changes.map((c) => ({
      ...named(c.field),
      before: c.before ?? null,
      after: c.after ?? null,
    }));
  }
  const flat = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object") return {};
    const { data, ...rest } = value as Record<string, unknown>;
    return data && typeof data === "object"
      ? { ...rest, ...(data as Record<string, unknown>) }
      : rest;
  };
  if (diff.kind === "create") return diffRecords({}, flat(diff.proposed), labels);
  if (diff.kind === "delete") return diffRecords(flat(diff.current), {}, labels);
  return diffRecords(flat(diff.current), flat(diff.proposed), labels);
}

export interface HistoryInput {
  id: string;
  apiPath: string;
  about: { created?: string; updated?: string; createdBy?: string; updatedBy?: string };
  snapshots?: SnapshotLike[];
  proposals?: ProposalLike[];
  /** The API's change history of the record. */
  changes?: ChangeLike[];
  /** Field key → label, for the diff. */
  labels?: Record<string, string>;
  /** Proposal id → the name of the person who approved it, for recorded changes. */
  approvers?: Record<string, string>;
}

/**
 * A recorded change's fields as DiffView changes: `data.price` is shown as `price` (an
 * entry's own field); a secret field shows that it changed, never its value (see
 * `Change.redacted` and `historyValue`).
 */
export function changeFields(change: ChangeLike, labels: Record<string, string> = {}): Change[] {
  return change.changes.map((c) => {
    const field = c.field.replace(/^data\./, "");
    const label = labels[field] ?? fieldWords(field);
    if (c.redacted) {
      return { field, label, redacted: true };
    }
    return {
      field,
      label,
      before: change.action === "create" ? null : (c.before ?? null),
      after: change.action === "delete" ? null : (c.after ?? null),
    };
  });
}

/** Every known event of the record, newest first. */
export function recordHistory(input: HistoryInput): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const { about, labels = {} } = input;
  const recorded = input.changes ?? [];
  const proposalIds = new Set(
    (input.proposals ?? [])
      .filter((p) => proposalTargets(p, input.apiPath, input.id))
      .map((p) => p.id)
  );
  // The newest recorded change covers the row's own "last updated" when it is that write.
  const newest = recorded.reduce<string>((max, c) => (c.at > max ? c.at : max), "");
  const sameMoment = (a: string, b: string) =>
    Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 5_000;

  for (const c of recorded) {
    // An approved proposal's write is already its proposal's event (agent and approver).
    if (c.proposalId && proposalIds.has(c.proposalId)) continue;
    const agent = c.actor.type === "agent";
    // An agent's write that a person approved, whose proposal is not listed here.
    const approved = !!c.proposalId && (agent || !!c.approvedBy);
    events.push({
      id: `change:${c.id}`,
      at: c.at,
      kind: "change",
      action: c.action,
      actor: agent ? undefined : (c.actor.name ?? undefined),
      agent: agent ? (c.actor.name ?? c.actor.id ?? undefined) : undefined,
      system: c.actor.type === "system" || undefined,
      truncated: c.truncated || undefined,
      ...(approved
        ? { status: "approved", decidedBy: input.approvers?.[c.proposalId!] ?? undefined }
        : {}),
      changes: changeFields(c, labels),
    });
  }
  const recordedCreate = recorded.some((c) => c.action === "create");

  if (about.created && !recordedCreate) {
    events.push({
      id: "created",
      at: about.created,
      kind: "created",
      actor: about.createdBy,
      changes: [],
    });
  }
  // "Updated" is only worth a line when it is not the creation itself.
  if (
    about.updated &&
    about.updated !== about.created &&
    !(newest && sameMoment(newest, about.updated))
  ) {
    events.push({
      id: "updated",
      at: about.updated,
      kind: "updated",
      actor: about.updatedBy,
      changes: [],
    });
  }

  const snapshots = [...(input.snapshots ?? [])]
    .filter((s) => s && typeof s.timestamp === "string")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  snapshots.forEach((snapshot, i) => {
    events.push({
      id: `snapshot:${snapshot.timestamp}:${i}`,
      at: snapshot.timestamp,
      kind: "snapshot",
      actor: snapshot.meta?.triggeredBy,
      note: snapshot.meta?.reason,
      changes: i === 0 ? [] : diffRecords(snapshots[i - 1]!.data, snapshot.data, labels),
    });
  });

  for (const p of input.proposals ?? []) {
    if (!proposalTargets(p, input.apiPath, input.id)) continue;
    events.push({
      id: `proposal:${p.id}`,
      at: p.executedAt ?? p.decidedAt ?? p.createdAt,
      kind: "proposal",
      agent: p.agentName ?? undefined,
      status: p.status,
      decidedBy: p.decidedByName ?? undefined,
      actor: p.decidedByName ?? undefined,
      note: p.comment ?? undefined,
      changes: proposalChanges(p, labels),
    });
  }

  return events.sort((a, b) => b.at.localeCompare(a.at));
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** tallao's TimelineItem. */
export interface HistoryLine {
  date: string;
  title: string;
  description?: string;
  tag?: string;
  tone?: "default" | "accent" | "success" | "warning" | "error";
  current?: boolean;
}

const ACTION_KEY = { create: "Created", update: "Updated", delete: "Deleted" } as const;

const PROPOSAL_TONE: Record<string, HistoryLine["tone"]> = {
  pending: "warning",
  approved: "success",
  executed: "success",
  rejected: "error",
  failed: "error",
  expired: "default",
};

/**
 * One timeline line per event. An agent's change says who asked AND who decided, and is
 * tagged "Agent", so it cannot be mistaken for a person's edit.
 */
export function historyLine(
  event: HistoryEvent,
  t: Translate,
  formatDate: (iso: string) => string
): HistoryLine {
  const who = event.actor ?? (event.system ? t("record.theSystem") : t("record.someone"));
  const count = event.changes.length;
  const changed =
    count === 1
      ? t("record.fieldChangedOne")
      : count > 0
        ? t("record.fieldsChanged", { n: count })
        : undefined;
  const date = formatDate(event.at);

  if (event.kind === "proposal") {
    const agent = event.agent ?? t("record.anAgent");
    const status = event.status ?? "pending";
    const title =
      status === "pending"
        ? t("record.agentAsks", { agent })
        : status === "rejected"
          ? t("record.agentRejected", { agent, who })
          : status === "expired"
            ? t("record.agentExpired", { agent })
            : status === "failed"
              ? t("record.agentFailed", { agent, who })
              : t("record.agentApproved", { agent, who });
    return {
      date,
      title,
      description: [changed, event.note].filter(Boolean).join(" · ") || undefined,
      tag: t("record.tagAgent"),
      tone: PROPOSAL_TONE[status] ?? "default",
    };
  }
  if (event.kind === "change") {
    const action = event.action ?? "update";
    const description =
      [changed, event.truncated ? t("record.someLeftOut") : undefined, event.note]
        .filter(Boolean)
        .join(" · ") || undefined;
    if (event.agent || event.status === "approved") {
      const agent = event.agent ?? t("record.anAgent");
      return {
        date,
        title:
          event.status === "approved"
            ? event.decidedBy
              ? t("record.agentApproved", { agent, who: event.decidedBy })
              : t("record.agentApprovedProposal", { agent })
            : t(`record.agent${ACTION_KEY[action]}`, { agent }),
        description,
        tag: t("record.tagAgent"),
        tone: action === "delete" ? "error" : event.status === "approved" ? "success" : "accent",
      };
    }
    const named = event.actor ?? (event.system ? t("record.theSystem") : undefined);
    return {
      date,
      title: named
        ? t(`record.change${ACTION_KEY[action]}By`, { who: named })
        : t(`record.change${ACTION_KEY[action]}`),
      description,
      tag: t(
        action === "create"
          ? "record.tagCreate"
          : action === "delete"
            ? "record.tagDelete"
            : "record.tagEdit"
      ),
      tone: action === "create" ? "accent" : action === "delete" ? "error" : "default",
    };
  }
  if (event.kind === "created") {
    return {
      date,
      title: event.actor ? t("record.createdBy", { who }) : t("record.created"),
      tag: t("record.tagCreate"),
      tone: "accent",
    };
  }
  if (event.kind === "snapshot") {
    return {
      date,
      title: event.actor ? t("record.savedBy", { who }) : t("record.saved"),
      description: [changed, event.note].filter(Boolean).join(" · ") || undefined,
      tag: t("record.tagEdit"),
    };
  }
  return {
    date,
    title: event.actor ? t("record.updatedBy", { who }) : t("record.updated"),
    tag: t("record.tagEdit"),
  };
}
