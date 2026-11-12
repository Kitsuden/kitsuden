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
  /** Shown instead of the value of a secret field (the API never sends it). */
  redactedText?: string;
}

/**
 * A recorded change's fields as DiffView changes: `data.price` is shown as `price` (an
 * entry's own field); a secret field shows that it changed, never its value.
 */
export function changeFields(
  change: ChangeLike,
  labels: Record<string, string> = {},
  redactedText = "hidden"
): Change[] {
  return change.changes.map((c) => {
    const field = c.field.replace(/^data\./, "");
    if (c.redacted) {
      return { field, label: labels[field], before: redactedText, after: redactedText };
    }
    return {
      field,
      label: labels[field],
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
    events.push({
      id: `change:${c.id}`,
      at: c.at,
      kind: "change",
      action: c.action,
      actor: agent ? undefined : (c.actor.name ?? undefined),
      agent: agent ? (c.actor.name ?? c.actor.id ?? undefined) : undefined,
      changes: changeFields(c, labels, input.redactedText),
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
  const who = event.actor ?? t("record.someone");
  const count = event.changes.length;
  const changed = count > 0 ? t("record.fieldsChanged", { n: count }) : undefined;
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
    const description = [changed, event.note].filter(Boolean).join(" · ") || undefined;
    if (event.agent) {
      return {
        date,
        title: t(`record.agent${ACTION_KEY[action]}`, { agent: event.agent }),
        description,
        tag: t("record.tagAgent"),
        tone: action === "delete" ? "error" : "accent",
      };
    }
    return {
      date,
      title: event.actor
        ? t(`record.change${ACTION_KEY[action]}By`, { who: event.actor })
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
