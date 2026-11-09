// @ts-nocheck

import { sql } from "drizzle-orm";

import { db } from "../src/db";

async function reset() {
  console.log("💥 content: Dropping 'public' schema...");

  try {
    // 1. Drop Schema
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    console.log("✅ Dropped schema 'public'");

    // 2. Recreate Schema
    await db.execute(sql`CREATE SCHEMA public`);
    console.log("✅ Created schema 'public'");

    // 3. Grant permissions (standard for Postgres 15+)
    await db.execute(sql`GRANT ALL ON SCHEMA public TO postgres`);
    await db.execute(sql`GRANT ALL ON SCHEMA public TO public`);
    console.log("✅ Permissions granted");
  } catch (err) {
    console.error("❌ Reset failed:", err);
    process.exit(1);
  }

  console.log("🚀 Clean slate ready.");
  process.exit(0);
}

reset();
