/**
 * Seed Dev User Script
 *
 * Creates a development user with username "admin" and password "developer"
 *
 * Usage:
 *   pnpm tsx scripts/seed-dev-user.ts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { scryptSync, randomBytes } from "crypto";
import { users, accounts } from "../lib/db/schema";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

/**
 * Hash password using scrypt (same as Better Auth)
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function seedDevUser() {
  console.log("🌱 Seeding development user...\n");

  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  const userId = "dev-admin-user";
  const email = "admin@example.com";
  const name = "admin";
  const password = "developer";

  try {
    // Check if user already exists
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (existingUser.length > 0) {
      console.log("✅ Dev user already exists:");
      console.log(`   Email: ${email}`);
      console.log(`   Name: ${name}`);
      console.log(`   Password: developer`);
      return;
    }

    // Create user
    const now = new Date();
    await db.insert(users).values({
      id: userId,
      name,
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      isAnonymous: false,
    });

    console.log("✅ Created user:");
    console.log(`   ID: ${userId}`);
    console.log(`   Email: ${email}`);
    console.log(`   Name: ${name}`);

    // Create credential account with hashed password
    const hashedPassword = hashPassword(password);
    const accountId = `dev-admin-account`;

    await db.insert(accounts).values({
      id: accountId,
      accountId: email, // Better Auth uses email as accountId for credential provider
      providerId: "credential",
      userId,
      password: hashedPassword,
      createdAt: now,
      updatedAt: now,
    });

    console.log("\n✅ Created credential account:");
    console.log(`   Provider: credential (email/password)`);
    console.log(`   Password: developer`);

    console.log("\n─".repeat(50));
    console.log("\n🎉 Dev user seeded successfully!");
    console.log("\nYou can now sign in with:");
    console.log("   Email: admin@localhost");
    console.log("   Password: developer");

  } catch (error) {
    console.error("❌ Failed to seed dev user:", error);
    process.exit(1);
  } finally {
    await queryClient.end();
  }
}

seedDevUser();
