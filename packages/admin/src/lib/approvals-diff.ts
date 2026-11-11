/**
 * A proposal's field diff, when it can be read.
 *
 * To someone who may see a proposal but not decide it, the API sends the diff REDACTED:
 * `{ redacted: true, reason: "viewer_cannot_approve" }` (routes/approvals.ts,
 * `REDACTED_CONTENT`). That object has no `fields`, and the inbox did
 * `fieldDiff.fields.length`: opening such a proposal threw and left the panel blank.
 */
import type { FieldDiff, ProposalDetail } from "$lib/types/approvals";

/** The diff with its fields, or `null` (none, or redacted). */
export function readableFieldDiff(
  p: Pick<ProposalDetail, "fieldDiff"> | null | undefined
): FieldDiff | null {
  const diff = p?.fieldDiff as (Partial<FieldDiff> & { redacted?: boolean }) | null | undefined;
  return diff && Array.isArray(diff.fields) ? (diff as FieldDiff) : null;
}

/** True when there is a diff and the API withheld it from this viewer. */
export function fieldDiffRedacted(
  p: Pick<ProposalDetail, "fieldDiff"> | null | undefined
): boolean {
  const diff = p?.fieldDiff as { redacted?: boolean } | null | undefined;
  return !!diff && diff.redacted === true;
}
