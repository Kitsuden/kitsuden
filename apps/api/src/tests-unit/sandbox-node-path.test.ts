/**
 * The sandbox launches Node by its absolute path
 * ============================================================================
 *
 * The child runs with an empty environment (no PATH). A bare `node` was found by
 * the `--version` probe, which has the API's PATH, and then not found when the child
 * was spawned: on Linux and in the Docker image every code action failed with
 * "Executable not found in $PATH: node".
 */
import { isAbsolute } from "node:path";

import { describe, expect, it } from "bun:test";

import { nodeWithPermissions } from "../lib/worker-sandbox";

describe("sandbox Node", () => {
  it("is an absolute path, or null when there is no Node 22+", () => {
    const node = nodeWithPermissions();
    if (node !== null) expect(isAbsolute(node)).toBe(true);
  });

  it("KITSUDEN_SANDBOX_RUNTIME=bun turns it off", () => {
    const before = process.env.KITSUDEN_SANDBOX_RUNTIME;
    process.env.KITSUDEN_SANDBOX_RUNTIME = "bun";
    try {
      expect(nodeWithPermissions()).toBeNull();
    } finally {
      if (before === undefined) delete process.env.KITSUDEN_SANDBOX_RUNTIME;
      else process.env.KITSUDEN_SANDBOX_RUNTIME = before;
    }
  });
});
