/**
 * Shared brain notes in an unattended run hold its writes (security audit 2026-11-19)
 * ============================================================================
 *
 * Editors and agents with `brain:write` can share a note that every agent's
 * brain search reads. The note was fenced as untrusted, but the run's writes
 * were held only when the prompt carried event data. Now an UNATTENDED run
 * (cron, action, rule, queue) whose turn carries a shared note written by
 * someone other than the run's agent or its sponsor holds every write for a
 * person. Interactive chat is unchanged.
 */
import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));

vi.mock("../../apps/api/src/db", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows.value,
  };
  return { db: chain };
});

import {
  getRelevantBrainNotes,
  hasForeignBrainNote,
  runHoldsWrites,
} from "../../apps/api/src/services/agent-engine";

const agent = { id: "ag_ops", sponsorUserId: "u_admin" };

describe("whose note is it", () => {
  it("the agent's own notes and its sponsor's are not foreign", () => {
    expect(hasForeignBrainNote([{ ownerAgentId: "ag_ops", ownerUserId: null }], agent)).toBe(false);
    expect(hasForeignBrainNote([{ ownerAgentId: null, ownerUserId: "u_admin" }], agent)).toBe(
      false
    );
    expect(hasForeignBrainNote([], agent)).toBe(false);
  });

  it("an editor's or another agent's shared note is foreign", () => {
    expect(hasForeignBrainNote([{ ownerAgentId: null, ownerUserId: "u_editor" }], agent)).toBe(
      true
    );
    expect(hasForeignBrainNote([{ ownerAgentId: "ag_low", ownerUserId: null }], agent)).toBe(true);
    // A note with no recorded owner is not trusted either.
    expect(hasForeignBrainNote([{ ownerAgentId: null, ownerUserId: null }], agent)).toBe(true);
    // An agent with no sponsor does not match a note with no owner user.
    expect(
      hasForeignBrainNote([{ ownerAgentId: null, ownerUserId: null }], {
        id: "ag_x",
        sponsorUserId: null,
      })
    ).toBe(true);
  });

  it("the brain search returns who wrote each note", async () => {
    rows.value = [
      { id: "n1", title: "t", content: "c", ownerAgentId: null, ownerUserId: "u_editor" },
    ];
    const notes = await getRelevantBrainNotes("deploy", "ag_ops");
    expect(notes[0]).toMatchObject({ ownerAgentId: null, ownerUserId: "u_editor" });
    expect(hasForeignBrainNote(notes, agent)).toBe(true);
  });
});

describe("when the run's writes are held", () => {
  it("an unattended run with a foreign note holds writes", () => {
    expect(runHoldsWrites({ unattended: true }, true)).toBe(true);
  });

  it("interactive chat with a foreign note stays as it was", () => {
    expect(runHoldsWrites({}, true)).toBe(false);
    expect(runHoldsWrites({ unattended: false }, true)).toBe(false);
  });

  it("an unattended run without a foreign note is free; event data still holds", () => {
    expect(runHoldsWrites({ unattended: true }, false)).toBe(false);
    expect(runHoldsWrites({ holdWrites: true }, false)).toBe(true);
  });
});
