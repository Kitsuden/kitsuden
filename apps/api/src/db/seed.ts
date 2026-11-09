/**
 * Seed Script — Creates the initial superadmin user
 *
 * Run: bun run src/db/seed.ts
 */

import { randomBytes } from "crypto";

import { messageOf } from "@kitsuden/engine";
import { eq } from "drizzle-orm";

import { inProduction } from "../lib/environment";
import { insertCredentialUser } from "../lib/first-run";

import { authUsers as user } from "./schema";

import { db } from "./index";

/**
 * An address nobody can receive mail at by default (`example.com` is reserved):
 * whoever controls the seeded address can reset this admin's password. A real
 * install names its own, and production refuses to guess.
 */
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim() || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_SEED_PASSWORD || randomBytes(16).toString("hex");
const ADMIN_NAME = "Kitsuden Admin";

async function seed() {
  if (inProduction() && !process.env.SEED_ADMIN_EMAIL?.trim()) {
    console.error("  ✗ Set SEED_ADMIN_EMAIL: production does not seed a default admin address.");
    process.exit(1);
  }
  console.log("🌱 Seeding superadmin user...");
  let userId = "";

  // Check if admin already exists
  const existing = await db.select().from(user).where(eq(user.email, ADMIN_EMAIL)).limit(1);

  if (existing[0]?.role === "admin") {
    // Not recreated: this script used to delete whatever account had the address.
    userId = existing[0].id;
    console.log(`  ✓ Admin exists: ${existing[0].email}. Keeping it and its password.`);
  } else if (existing.length) {
    // Not promoted: with open sign-up, anyone can pre-register an address.
    console.error(
      `  ✗ ${ADMIN_EMAIL} already exists and is not an admin. Promote it from the panel, or set SEED_ADMIN_EMAIL.`
    );
    process.exit(1);
  } else {
    try {
      await db.transaction(async (tx) => {
        const created = await insertCredentialUser(tx, {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          name: ADMIN_NAME,
        });
        await tx
          .update(user)
          .set({ role: "admin", emailVerified: true })
          .where(eq(user.id, created.id));
        userId = created.id;
      });

      console.log(`  ✓ Created admin: ${ADMIN_EMAIL}`);
      // Only if this script generated it: if it came from ADMIN_SEED_PASSWORD, whoever
      // set it already has it, and it must not end up in logs.
      console.log(
        `    Password: ${process.env.ADMIN_SEED_PASSWORD ? "(la de ADMIN_SEED_PASSWORD)" : ADMIN_PASSWORD}`
      );
      console.log(`    ⚠ IMPORTANT: Save this password or set ADMIN_SEED_PASSWORD env var.`);
      console.log(`    Role: admin`);
    } catch (err: unknown) {
      console.error("  ✗ Error creating admin:", messageOf(err) || err);
      process.exit(1);
    }
  }

  // ══════════════════════════════════════════════
  // Seed Content (Games, Posts, etc.)
  // ══════════════════════════════════════════════

  console.log("🌱 Seeding content...");

  // Import schema tables dynamically to avoid top-level issues if needed,
  // but we already imported user. Let's import the rest.
  const { games, blogPosts, platforms, tags, siteSettings } = (await import("./schema")) as any;

  // 1. Platforms
  const platformData = [
    { name: "PC", slug: "pc", shortName: "PC" },
    { name: "PlayStation 5", slug: "ps5", shortName: "PS5" },
    { name: "Xbox Series X", slug: "xbox-series-x", shortName: "XSX" },
    { name: "Nintendo Switch", slug: "switch", shortName: "Switch" },
  ];

  for (const p of platformData) {
    await db
      .insert(platforms as any)
      .values(p)
      .onConflictDoNothing();
  }
  console.log("  ✓ Platforms seeded");

  // 2. Tags
  const tagData = [
    { name: "Action", slug: "action", category: "genre" },
    { name: "RPG", slug: "rpg", category: "genre" },
    { name: "Adventure", slug: "adventure", category: "genre" },
    { name: "Indie", slug: "indie", category: "genre" },
    { name: "Multiplayer", slug: "multiplayer", category: "feature" },
    { name: "Singleplayer", slug: "singleplayer", category: "feature" },
  ];

  for (const t of tagData) {
    await db
      .insert(tags as any)
      .values(t as any)
      .onConflictDoNothing();
  }
  console.log("  ✓ Tags seeded");

  // 3. Games
  // Example games, fictitious on purpose: the seed belongs to the product and
  // must not bring real titles or promotional texts from their publishers.
  const gameData = [
    {
      title: "Example Quest",
      slug: "example-quest",
      status: "published",
      metacriticScore: 90,
      developer: "Example Studio",
      excerpt:
        "A sample action RPG used to show how games, tags and blog posts fit together in Kitsuden.",
    },
    {
      title: "Sample Tactics",
      slug: "sample-tactics",
      status: "published",
      metacriticScore: 85,
      developer: "Sample Games",
      excerpt: "A sample turn-based strategy game. Replace it with your own catalog.",
    },
    {
      title: "Demo Racer",
      slug: "demo-racer",
      status: "published",
      metacriticScore: 80,
      developer: "Demo Works",
      excerpt: "A sample racing game included only as seed data.",
    },
  ];

  for (const g of gameData) {
    await db
      .insert(games as any)
      .values(g as any)
      .onConflictDoNothing();
  }
  console.log("  ✓ Games seeded");

  // 4. Blog Posts
  const postData = [
    {
      title: "Welcome to Kitsuden",
      slug: "welcome-to-kitsuden",
      status: "published",
      excerpt: "Introducing Kitsuden — the high-performance gaming CMS.",
      publishedAt: new Date(),
      authorId: userId,
    },
  ];

  for (const p of postData) {
    await db
      .insert(blogPosts as any)
      .values(p as any)
      .onConflictDoNothing();
  }
  console.log("  ✓ Blog Posts seeded");

  // 5. Settings
  await db
    .insert(siteSettings)
    .values({
      siteName: "Kitsuden",
      activeTheme: "kitsuden-cms",
      mainNav: [
        { label: "Home", url: "/" },
        { label: "Games", url: "/games" },
        { label: "Blog", url: "/blog" },
      ],
    })
    .onConflictDoNothing();

  console.log("🌱 Seed complete.");
  process.exit(0);
}

seed();
