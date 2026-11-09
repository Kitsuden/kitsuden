/**
 * Re-encrypt the stored secrets with a new KITSUDEN_SECRETS_KEY.
 *
 *   cd apps/api
 *   KITSUDEN_SECRETS_KEY=<new> DATABASE_URL=$DATABASE_ADMIN_URL bun run scripts/rekey-secrets.ts --dry-run
 *   KITSUDEN_SECRETS_KEY=<new> DATABASE_URL=$DATABASE_ADMIN_URL bun run scripts/rekey-secrets.ts
 *
 * In the container: `docker exec <api-container> sh -c 'cd /app/apps/api &&
 * DATABASE_URL=$DATABASE_ADMIN_URL bun run scripts/rekey-secrets.ts'` after
 * adding the new KITSUDEN_SECRETS_KEY to `.env` and recreating the container.
 *
 * The OLD key is `KITSUDEN_SECRETS_KEY_OLD` if set, otherwise `BETTER_AUTH_SECRET`
 * (what an install without KITSUDEN_SECRETS_KEY used). One transaction: if any
 * row decrypts with neither key nothing changes. Running it twice is harmless.
 * Take a backup first (docs/install/upgrade-and-backups.md). See lib/secrets-rekey.ts.
 */

import { db } from "../src/db";
import { RekeyError, rekeySecrets } from "../src/lib/secrets-rekey";

const dryRun = process.argv.includes("--dry-run");
const newRaw = process.env.KITSUDEN_SECRETS_KEY ?? "";
const oldRaw = process.env.KITSUDEN_SECRETS_KEY_OLD || process.env.BETTER_AUTH_SECRET || "";

async function main(): Promise<number> {
  if (!newRaw) {
    console.error("Set the NEW key in KITSUDEN_SECRETS_KEY (openssl rand -hex 32).");
    return 1;
  }
  if (!oldRaw) {
    console.error(
      "Set the OLD key in KITSUDEN_SECRETS_KEY_OLD, or BETTER_AUTH_SECRET if the install had none."
    );
    return 1;
  }
  try {
    const report = await rekeySecrets(db as never, { oldRaw, newRaw, dryRun });
    for (const [store, s] of Object.entries(report.stores)) {
      console.log(
        `  ${store}: ${s.rekeyed} ${dryRun ? "to re-encrypt" : "re-encrypted"}, ${s.alreadyNew} already on the new key`
      );
    }
    console.log(
      dryRun
        ? "Dry run: nothing was written."
        : "Done. Restart the API with the new KITSUDEN_SECRETS_KEY."
    );
    return 0;
  } catch (err) {
    console.error(err instanceof RekeyError ? err.message : err);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
