import { randomBytes } from "crypto";

import { eq } from "drizzle-orm";

import { insertCredentialUser } from "../lib/first-run";

import { authUsers as user } from "./schema";

import { db } from "./index";

/**
 * Creates an admin account. Nothing is hardcoded: the email comes from
 * `SEED_ADMIN_EMAIL` and the display name from `SEED_ADMIN_NAME`.
 *
 * It does not promote an account that already exists: with open sign-up, anyone
 * can pre-register that address with their own password.
 */
async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  if (!email) {
    console.error("❌ Set SEED_ADMIN_EMAIL to the admin account's email.");
    process.exit(1);
  }
  const password = process.env.USER_SEED_PASSWORD || randomBytes(16).toString("hex");

  console.log(`Checking if ${email} exists...`);
  const existing = await db.select().from(user).where(eq(user.email, email)).limit(1);

  if (existing[0]?.role === "admin") {
    console.log("That account is already an admin. Nothing to do.");
  } else if (existing.length) {
    console.error(
      "❌ That account already exists and is not an admin. This script does not promote it:\n" +
        "   whoever registered it knows its password. Promote it from the panel (Users) once\n" +
        "   you know it is yours, or seed another address."
    );
    process.exit(1);
  } else {
    console.log("Creating user...");
    await db.transaction(async (tx) => {
      const created = await insertCredentialUser(tx, {
        email,
        password,
        name: process.env.SEED_ADMIN_NAME?.trim() || "Admin",
      });
      await tx
        .update(user)
        .set({ role: "admin", emailVerified: true })
        .where(eq(user.id, created.id));
    });
    console.log(`✅ Created admin ${email}`);
    // Only if this script generated it: if it came from USER_SEED_PASSWORD, whoever set it already has it.
    console.log(
      `   Password: ${process.env.USER_SEED_PASSWORD ? "(the one in USER_SEED_PASSWORD)" : password}`
    );
    console.log(`   ⚠ IMPORTANT: Save this password or set USER_SEED_PASSWORD env var.`);
  }
  process.exit(0);
}

seedAdmin();
