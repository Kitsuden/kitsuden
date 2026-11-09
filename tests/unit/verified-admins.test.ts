/**
 * Requiring email verification does not lock out those who already administer
 * ============================================================================
 *
 * Measured on a real installation before enabling mandatory verification:
 * a single administrator, with a password and `email_verified = false`. The initial
 * sign-up never verified anything. Without migration 0041, the deployment
 * would have answered «Email not verified» to the correct password.
 *
 * This test guards the two halves of the same contract:
 *   · administrators that ALREADY exist are left verified,
 *   · and NO other user is verified through the back door.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "..", "apps", "api", "src", "db", "migrations");

/** SQL without line comments, so the text's own mentions are not counted. */
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

describe("verification of existing administrators", () => {
  const file = readdirSync(MIGRATIONS).find((f) => /^\d+_existing_admins_verified\.sql$/.test(f));

  it("the migration exists", () => {
    expect(
      file,
      "without it, enabling requireEmailVerification locks out the already-created administrator"
    ).toBeDefined();
  });

  it("only touches unverified administrators", () => {
    const sql = withoutComments(readFileSync(join(MIGRATIONS, file!), "utf-8"));

    expect(sql).toMatch(/UPDATE\s+auth_users/i);
    expect(sql).toMatch(/SET\s+email_verified\s*=\s*true/i);
    expect(sql, "it has to be limited to administrators").toMatch(/role\s*=\s*'admin'/i);
    expect(sql, "it has to be idempotent").toMatch(/email_verified\s*=\s*false/i);
  });

  it("no other migration verifies users in bulk", () => {
    /**
     * Marking anyone as verified is exactly what verification
     * is meant to prevent. If another migration appears that does it,
     * someone must have decided it on purpose.
     */
    const others = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f !== file)
      .filter((f) =>
        /SET\s+email_verified\s*=\s*true/i.test(
          withoutComments(readFileSync(join(MIGRATIONS, f), "utf-8"))
        )
      );

    expect(others).toEqual([]);
  });
});
