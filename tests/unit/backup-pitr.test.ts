/**
 * Point-in-time restore: the two rules of `apps/api/scripts/backup.ts --base`
 * that decide what survives in the WAL archive
 * ============================================================================
 *
 * Pruning too much makes the oldest kept base unrestorable; pruning too little
 * fills the disk. The rule is `pg_archivecleanup`'s: everything named before the
 * oldest kept base's first segment goes, timeline history files never do.
 *
 * The end-to-end path (archive, base backup, restore to a timestamp) was run
 * with throwaway containers; it needs Docker and is not part of this suite.
 */

import { describe, expect, it } from "vitest";

import { prunableWal, startWalOf } from "../../apps/api/scripts/backup";

describe("startWalOf", () => {
  it("reads the first segment from a backup_label", () => {
    const label = [
      "START WAL LOCATION: 0/5000028 (file 000000010000000000000005)",
      "CHECKPOINT LOCATION: 0/5000060",
      "BACKUP METHOD: streamed",
      "LABEL: kitsuden base-2026-11-04T10-00-00",
    ].join("\n");
    expect(startWalOf(label)).toBe("000000010000000000000005");
  });

  it("gives null for anything else", () => {
    expect(startWalOf("")).toBeNull();
    expect(startWalOf("START WAL LOCATION: 0/5000028")).toBeNull();
  });
});

describe("prunableWal", () => {
  const start = "000000020000000000000010";
  const archive = [
    "00000001000000000000000F.gz", // older timeline, older segment
    "000000010000000000000012.gz", // older timeline: sorts before timeline 2
    "00000002000000000000000F.gz", // same timeline, before the base
    "00000002000000000000000F.00000028.backup.gz",
    "000000020000000000000010.gz", // the base's first segment: kept
    "000000020000000000000011.gz",
    "000000030000000000000011.gz", // a later timeline: kept
    "00000002.history.gz", // history files: never
    "00000003.history.gz",
    "something-else.txt",
  ];

  it("removes exactly what sorts before the oldest kept base", () => {
    expect(prunableWal(archive, start)).toEqual([
      "00000001000000000000000F.gz",
      "000000010000000000000012.gz",
      "00000002000000000000000F.gz",
      "00000002000000000000000F.00000028.backup.gz",
    ]);
  });

  it("keeps history files and unknown names", () => {
    const gone = prunableWal(archive, start);
    expect(gone.some((n) => n.includes(".history"))).toBe(false);
    expect(gone).not.toContain("something-else.txt");
  });
});
