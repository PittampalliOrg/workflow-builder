/**
 * Seed Dev User Script
 *
 * Creates a development user with email "admin@example.com" and password "developer"
 * Also creates the default platform, signing key, project, and project membership.
 *
 * Usage:
 *   pnpm tsx scripts/seed-dev-user.ts
 */
import bcrypt from "bcryptjs";
import { createPrivateKey, createPublicKey } from "crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
	platforms,
	projectMembers,
	projects,
	signingKeys,
	userIdentities,
	users,
} from "../lib/db/schema";
import { generateId } from "../lib/utils/id";

const DATABASE_URL =
	process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

async function seedDevUser() {
	console.log("Seeding development user...\n");

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
			console.log("Dev user already exists:");
			console.log(`   Email: ${email}`);
			console.log(`   Name: ${name}`);
			console.log(`   Password: developer`);
			return;
		}

		const now = new Date();

		// 1. Create or get default platform
		const platformId = "default-platform";
		const existingPlatform = await db
			.select()
			.from(platforms)
			.where(eq(platforms.id, platformId))
			.limit(1);

		if (existingPlatform.length === 0) {
			await db.insert(platforms).values({
				id: platformId,
				name: "Default Platform",
				ownerId: userId,
				createdAt: now,
				updatedAt: now,
			});
			console.log("Created default platform");
		}

		// 2. Derive and store signing public key from JWT_SIGNING_KEY
		const existingKey = await db
			.select()
			.from(signingKeys)
			.where(eq(signingKeys.platformId, platformId))
			.limit(1);

		if (existingKey.length === 0) {
			const privateKeyPem = process.env.JWT_SIGNING_KEY;
			if (privateKeyPem) {
				const privateKey = createPrivateKey(privateKeyPem);
				const publicKey = createPublicKey(privateKey);
				const publicKeyPem = publicKey.export({
					type: "spki",
					format: "pem",
				}) as string;

				await db.insert(signingKeys).values({
					id: generateId(),
					platformId,
					publicKey: publicKeyPem,
					algorithm: "RS256",
					displayName: "Derived from JWT_SIGNING_KEY",
					createdAt: now,
					updatedAt: now,
				});
				console.log("Created signing key (derived from JWT_SIGNING_KEY)");
			} else {
				console.log(
					"Skipping signing key (JWT_SIGNING_KEY not set, will auto-derive at runtime)",
				);
			}
		}

		// 3. Create user
		await db.insert(users).values({
			id: userId,
			name,
			email,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
			platformId,
			platformRole: "ADMIN",
			status: "ACTIVE",
		});

		console.log("Created user:");
		console.log(`   ID: ${userId}`);
		console.log(`   Email: ${email}`);
		console.log(`   Name: ${name}`);

		// 4. Create user identity with bcrypt password hash
		const hashedPassword = await bcrypt.hash(password, 10);

		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			email,
			password: hashedPassword,
			provider: "EMAIL",
			firstName: name,
			lastName: null,
			tokenVersion: 0,
			verified: true,
			createdAt: now,
			updatedAt: now,
		});

		console.log("Created user identity (bcrypt password)");

		// 5. Create default project
		const projectId = "dev-default-project";
		await db.insert(projects).values({
			id: projectId,
			platformId,
			ownerId: userId,
			displayName: "Default Project",
			externalId: `project-${userId}`,
			createdAt: now,
			updatedAt: now,
		});

		console.log("Created default project");

		// 6. Create project membership (ADMIN)
		await db.insert(projectMembers).values({
			id: generateId(),
			projectId,
			userId,
			role: "ADMIN",
			createdAt: now,
			updatedAt: now,
		});

		console.log("Created project membership (ADMIN role)");

		console.log("\n" + "-".repeat(50));
		console.log("\nDev user seeded successfully!");
		console.log("\nYou can now sign in with:");
		console.log("   Email: admin@example.com");
		console.log("   Password: developer");
	} catch (error) {
		console.error("Failed to seed dev user:", error);
		process.exit(1);
	} finally {
		await queryClient.end();
	}
}

seedDevUser();
