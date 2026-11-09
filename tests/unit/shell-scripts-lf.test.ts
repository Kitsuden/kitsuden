/**
 * Shell scripts have to be in LF
 * ============================================================================
 *
 * A `.sh` with Windows line endings is syntactically valid on Windows
 * and garbage in a Linux container: `sh` swallows the `\r` as part of the token,
 * so `set -e` is read as `set -e\r` and the interpreter answers
 *
 *     set: line 10: illegal option -
 *
 * which mentions neither the file, nor the carriage return, nor anything that leads to the
 * cause. It really happened: `kitsuden_api_prod` started, died, retried, and
 * `docker compose up` only said «dependency failed to start: container
 * kitsuden_api_prod is unhealthy». Nine scripts were in CRLF.
 *
 * ── WHY .gitattributes IS NOT ENOUGH ───────────────────────────────────────
 *
 * The repo ALREADY declares `*.sh text eol=lf`. The rule is right and did
 * nothing, because it was added AFTER the files were in the working
 * tree, and `.gitattributes` only acts when going through git. With
 * `core.autocrlf=true` —normal on Windows— any file that is created or
 * touched outside that path is born in CRLF again.
 *
 * And Docker copies from the WORKING TREE, not from the index. What git would normalize
 * on commit does not matter: what is on disk goes into the image.
 *
 * That is why this is checked on the file's bytes and not on git's
 * configuration.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** The `.sh` files in the folders that end up inside an image or a deployment. */
function scripts(): string[] {
  const foundItems: string[] = [];
  for (const dir of ["docker", "scripts"]) {
    for (const input of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (input.isFile() && input.name.endsWith(".sh")) {
        foundItems.push(join(dir, input.name));
      }
    }
  }
  return foundItems;
}

describe("shell scripts carry no CRLF", () => {
  const files = scripts();

  it("there are scripts to inspect", () => {
    // Without this, a failure to list would leave the list empty and the check
    // below would pass without looking at a single file.
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    it(`${file}`, () => {
      const bytes = readFileSync(join(ROOT, file));
      const first = bytes.indexOf("\r\n");

      expect(
        first,
        `${file} has CRLF (first occurrence at byte ${first}). On Linux, ` +
          `sh includes the \r in the token: 'set -e' becomes 'set -e\r' and the ` +
          `container dies with "illegal option -". Convert it to LF; ` +
          `.gitattributes does not fix it by itself, because Docker copies from the ` +
          `working tree and not from the index.`
      ).toBe(-1);
    });
  }
});
