/**
 * Seed Dev User Script
 *
 * Seeds:
 * 1. Local dev email/password user (`admin@example.com` / `developer`)
 * 2. Optional GitHub OAuth user from env (`SEED_GITHUB_USER_*`)
 * 3. Optional user API keys (`SEED_GITHUB_USER_API_KEY*`)
 *
 * API keys are stored exactly like runtime generation/validation:
 * - key_hash = sha256(plaintext_key)
 * - key_prefix = first 11 chars (e.g. "wfb_abcd123")
 *
 * Usage:
 *   pnpm tsx scripts/seed-dev-user.ts
 */
import bcrypt from "bcryptjs";
import { createHash, createPrivateKey, createPublicKey } from "crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	apiKeys,
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
const DEFAULT_PLATFORM_ID = "default-platform";
const DEV_USER_ID = "dev-admin-user";
const DEV_USER_EMAIL = "admin@example.com";
const DEV_USER_NAME = "admin";
const DEV_USER_PASSWORD = "developer";
const DEV_PROJECT_ID = "dev-default-project";

type SeedUserSpec = {
	id: string;
	email: string;
	name: string | null;
	image?: string | null;
	provider: "EMAIL" | "GITHUB";
	password?: string;
	platformRole: "ADMIN" | "MEMBER";
	projectId?: string;
	projectDisplayName?: string;
	projectExternalId?: string;
};

type SeedApiKeySpec = {
	name: string | null;
	key: string;
};

function toNameParts(name: string | null): {
	firstName: string | null;
	lastName: string | null;
} {
	if (!name) {
		return { firstName: null, lastName: null };
	}
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return {
		firstName: parts[0] || null,
		lastName: parts.slice(1).join(" ") || null,
	};
}

function parseSeedApiKeys(): SeedApiKeySpec[] {
	const parsed: SeedApiKeySpec[] = [];
	const seen = new Set<string>();

	const addKey = (value: string | null | undefined, name: string | null) => {
		const key = value?.trim();
		if (!key || seen.has(key)) {
			return;
		}
		seen.add(key);
		parsed.push({ name: name?.trim() || null, key });
	};

	const rawJson = process.env.SEED_GITHUB_USER_API_KEYS_JSON?.trim();
	if (rawJson) {
		try {
			const raw = JSON.parse(rawJson) as unknown;
			if (!Array.isArray(raw)) {
				throw new Error("SEED_GITHUB_USER_API_KEYS_JSON must be an array");
			}
			for (const item of raw) {
				if (typeof item === "string") {
					addKey(item, null);
					continue;
				}
				if (
					typeof item === "object" &&
					item !== null &&
					"key" in item &&
					typeof item.key === "string"
				) {
					addKey(
						item.key,
						"name" in item && typeof item.name === "string" ? item.name : null,
					);
					continue;
				}
				throw new Error(
					"SEED_GITHUB_USER_API_KEYS_JSON entries must be strings or { key, name } objects",
				);
			}
		} catch (error) {
			throw new Error(
				`Invalid SEED_GITHUB_USER_API_KEYS_JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const rawList = process.env.SEED_GITHUB_USER_API_KEYS?.trim();
	if (rawList) {
		for (const value of rawList.split(/[,\n]/)) {
			addKey(value, null);
		}
	}

	addKey(
		process.env.SEED_GITHUB_USER_API_KEY,
		process.env.SEED_GITHUB_USER_API_KEY_NAME || null,
	);
	return parsed;
}

function hashApiKey(key: string): { keyHash: string; keyPrefix: string } {
	return {
		keyHash: createHash("sha256").update(key).digest("hex"),
		keyPrefix: key.slice(0, 11),
	};
}

async function ensureDefaultPlatform(
	db: ReturnType<typeof drizzle>,
	ownerId: string,
) {
	const existingPlatform = await db
		.select()
		.from(platforms)
		.where(eq(platforms.id, DEFAULT_PLATFORM_ID))
		.limit(1);

	if (existingPlatform.length === 0) {
		const now = new Date();
		await db.insert(platforms).values({
			id: DEFAULT_PLATFORM_ID,
			name: "Default Platform",
			ownerId,
			createdAt: now,
			updatedAt: now,
		});
		console.log("Created default platform");
	}
}

async function ensureSigningPublicKey(
	db: ReturnType<typeof drizzle>,
	platformId: string,
) {
	const existingKey = await db
		.select()
		.from(signingKeys)
		.where(eq(signingKeys.platformId, platformId))
		.limit(1);

	if (existingKey.length > 0) {
		return;
	}

	const privateKeyPem = process.env.JWT_SIGNING_KEY;
	if (!privateKeyPem) {
		console.log(
			"Skipping signing key (JWT_SIGNING_KEY not set, will auto-derive at runtime)",
		);
		return;
	}

	const privateKey = createPrivateKey(privateKeyPem);
	const publicKey = createPublicKey(privateKey);
	const publicKeyPem = publicKey.export({
		type: "spki",
		format: "pem",
	}) as string;

	const now = new Date();
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
}

async function ensureProjectForUser(
	db: ReturnType<typeof drizzle>,
	userId: string,
	platformId: string,
	opts?: {
		projectId?: string;
		projectDisplayName?: string;
		projectExternalId?: string;
	},
) {
	const now = new Date();
	const externalId = opts?.projectExternalId ?? `project-${userId}`;
	const displayName = opts?.projectDisplayName ?? "Default Project";

	const existingProject = await db
		.select()
		.from(projects)
		.where(eq(projects.externalId, externalId))
		.limit(1);

	let projectId: string;
	if (existingProject.length === 0) {
		projectId = opts?.projectId ?? generateId();
		await db.insert(projects).values({
			id: projectId,
			platformId,
			ownerId: userId,
			displayName,
			externalId,
			createdAt: now,
			updatedAt: now,
		});
		console.log(`Created default project for user ${userId}`);
	} else {
		projectId = existingProject[0].id;
	}

	const membership = await db
		.select()
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, projectId),
				eq(projectMembers.userId, userId),
			),
		)
		.limit(1);

	if (membership.length === 0) {
		await db.insert(projectMembers).values({
			id: generateId(),
			projectId,
			userId,
			role: "ADMIN",
			createdAt: now,
			updatedAt: now,
		});
		console.log(`Created project membership (ADMIN) for user ${userId}`);
	}
}

async function upsertUserWithIdentity(
	db: ReturnType<typeof drizzle>,
	spec: SeedUserSpec,
	platformId: string,
): Promise<string> {
	const now = new Date();
	let existing = await db
		.select()
		.from(users)
		.where(eq(users.id, spec.id))
		.limit(1);

	if (existing.length === 0) {
		existing = await db
			.select()
			.from(users)
			.where(eq(users.email, spec.email))
			.limit(1);
	}

	let userId = spec.id;
	if (existing.length === 0) {
		await db.insert(users).values({
			id: spec.id,
			name: spec.name,
			email: spec.email,
			emailVerified: true,
			image: spec.image ?? null,
			createdAt: now,
			updatedAt: now,
			platformId,
			platformRole: spec.platformRole,
			status: "ACTIVE",
		});
		console.log(`Created user ${spec.email} (${spec.provider})`);
	} else {
		userId = existing[0].id;
		await db
			.update(users)
			.set({
				name: spec.name ?? existing[0].name ?? null,
				email: spec.email,
				image: spec.image ?? existing[0].image ?? null,
				emailVerified: true,
				platformId: existing[0].platformId ?? platformId,
				platformRole: existing[0].platformRole ?? spec.platformRole,
				status: "ACTIVE",
				updatedAt: now,
			})
			.where(eq(users.id, userId));
		console.log(`Updated existing user ${spec.email} (${spec.provider})`);
	}

	const identity = await db
		.select()
		.from(userIdentities)
		.where(
			and(
				eq(userIdentities.userId, userId),
				eq(userIdentities.provider, spec.provider),
			),
		)
		.limit(1);

	const { firstName, lastName } = toNameParts(spec.name);
	const passwordHash = spec.password
		? await bcrypt.hash(spec.password, 10)
		: null;

	if (identity.length === 0) {
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			email: spec.email,
			password: passwordHash,
			provider: spec.provider,
			firstName,
			lastName,
			tokenVersion: 0,
			verified: true,
			createdAt: now,
			updatedAt: now,
		});
		console.log(`Created ${spec.provider} identity for ${spec.email}`);
	} else {
		await db
			.update(userIdentities)
			.set({
				email: spec.email,
				firstName,
				lastName,
				password:
					spec.provider === "EMAIL" && passwordHash
						? passwordHash
						: identity[0].password,
				verified: true,
				updatedAt: now,
			})
			.where(eq(userIdentities.id, identity[0].id));
	}

	await ensureProjectForUser(db, userId, platformId, {
		projectId: spec.projectId,
		projectDisplayName: spec.projectDisplayName,
		projectExternalId: spec.projectExternalId,
	});
	return userId;
}

async function findGithubUserId(
	db: ReturnType<typeof drizzle>,
): Promise<string | null> {
	const githubIdentities = await db
		.select({ userId: userIdentities.userId })
		.from(userIdentities)
		.where(eq(userIdentities.provider, "GITHUB"))
		.limit(2);

	if (githubIdentities.length === 0) {
		return null;
	}
	if (githubIdentities.length > 1) {
		throw new Error(
			"Multiple GitHub users found. Set SEED_GITHUB_USER_ID (preferred) or SEED_GITHUB_USER_EMAIL.",
		);
	}
	return githubIdentities[0].userId;
}

async function resolveExistingGithubUserId(
	db: ReturnType<typeof drizzle>,
	opts: { userId?: string; email?: string },
): Promise<string> {
	const userId = opts.userId?.trim();
	const email = opts.email?.trim();

	if (userId) {
		const identity = await db
			.select({ userId: userIdentities.userId })
			.from(userIdentities)
			.where(
				and(
					eq(userIdentities.userId, userId),
					eq(userIdentities.provider, "GITHUB"),
				),
			)
			.limit(1);
		if (identity.length === 0) {
			throw new Error(
				`SEED_GITHUB_USER_ID (${userId}) does not have a GITHUB identity.`,
			);
		}
		return userId;
	}

	if (email) {
		const matches = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(2);

		if (matches.length === 0) {
			throw new Error(
				`SEED_GITHUB_USER_EMAIL (${email}) does not match an existing user.`,
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`SEED_GITHUB_USER_EMAIL (${email}) matched multiple users. Set SEED_GITHUB_USER_ID explicitly.`,
			);
		}

		const resolvedUserId = matches[0].id;
		const identity = await db
			.select({ userId: userIdentities.userId })
			.from(userIdentities)
			.where(
				and(
					eq(userIdentities.userId, resolvedUserId),
					eq(userIdentities.provider, "GITHUB"),
				),
			)
			.limit(1);

		if (identity.length === 0) {
			throw new Error(
				`User matched by SEED_GITHUB_USER_EMAIL (${email}) does not have a GITHUB identity.`,
			);
		}
		return resolvedUserId;
	}

	throw new Error(
		"Cannot resolve existing GitHub user. Set SEED_GITHUB_USER_ID (preferred) or SEED_GITHUB_USER_EMAIL.",
	);
}

async function seedApiKeysForUser(
	db: ReturnType<typeof drizzle>,
	userId: string,
	keys: SeedApiKeySpec[],
) {
	if (keys.length === 0) {
		return;
	}

	for (const entry of keys) {
		if (!entry.key.startsWith("wfb_")) {
			throw new Error(
				`Invalid seeded API key format for "${entry.name ?? "unnamed"}". Expected key to start with "wfb_".`,
			);
		}

		const { keyHash, keyPrefix } = hashApiKey(entry.key);
		const existing = await db
			.select({
				id: apiKeys.id,
				userId: apiKeys.userId,
				name: apiKeys.name,
			})
			.from(apiKeys)
			.where(eq(apiKeys.keyHash, keyHash))
			.limit(1);

		if (existing.length > 0) {
			if (existing[0].userId !== userId) {
				throw new Error(
					`Seeded API key hash for "${entry.name ?? "unnamed"}" already belongs to another user.`,
				);
			}
			if (entry.name && entry.name !== existing[0].name) {
				await db
					.update(apiKeys)
					.set({ name: entry.name })
					.where(eq(apiKeys.id, existing[0].id));
			}
			console.log(
				`API key "${entry.name ?? keyPrefix}" already exists for user ${userId}`,
			);
			continue;
		}

		await db.insert(apiKeys).values({
			userId,
			name: entry.name,
			keyHash,
			keyPrefix,
		});
		console.log(
			`Created API key "${entry.name ?? keyPrefix}" for user ${userId}`,
		);
	}
}

async function seedDevUser() {
	console.log("Seeding development user...\n");

	const queryClient = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(queryClient);

	try {
		await ensureDefaultPlatform(db, DEV_USER_ID);
		await ensureSigningPublicKey(db, DEFAULT_PLATFORM_ID);

		await upsertUserWithIdentity(
			db,
			{
				id: DEV_USER_ID,
				email: DEV_USER_EMAIL,
				name: DEV_USER_NAME,
				provider: "EMAIL",
				password: DEV_USER_PASSWORD,
				platformRole: "ADMIN",
				projectId: DEV_PROJECT_ID,
				projectDisplayName: "Default Project",
				projectExternalId: `project-${DEV_USER_ID}`,
			},
			DEFAULT_PLATFORM_ID,
		);

		const githubEmail = process.env.SEED_GITHUB_USER_EMAIL?.trim();
		const githubName =
			process.env.SEED_GITHUB_USER_NAME?.trim() || "GitHub User";
		const githubImage = process.env.SEED_GITHUB_USER_IMAGE?.trim() || null;
		const githubUserIdEnv = process.env.SEED_GITHUB_USER_ID?.trim();
		const seedApiKeys = parseSeedApiKeys();

		let githubUserId: string | null = null;
		if (githubEmail) {
			githubUserId = await upsertUserWithIdentity(
				db,
				{
					id: githubUserIdEnv || "seed-github-user",
					email: githubEmail,
					name: githubName,
					image: githubImage,
					provider: "GITHUB",
					platformRole: "MEMBER",
				},
				DEFAULT_PLATFORM_ID,
			);
		} else {
			githubUserId = await findGithubUserId(db);
		}

		if (seedApiKeys.length > 0) {
			if (githubUserId) {
				console.log(`Using GitHub user ${githubUserId} for API key seeding`);
			} else {
				githubUserId = await resolveExistingGithubUserId(db, {
					userId: githubUserIdEnv,
					email: githubEmail,
				});
				console.log(
					`Resolved existing GitHub user ${githubUserId} for API key seeding`,
				);
			}
			await seedApiKeysForUser(db, githubUserId, seedApiKeys);
		}

		console.log("\n" + "-".repeat(50));
		console.log("\nDatabase seed completed successfully!");
		console.log("\nEmail/password user:");
		console.log(`   Email: ${DEV_USER_EMAIL}`);
		console.log(`   Password: ${DEV_USER_PASSWORD}`);
		if (githubEmail) {
			console.log("\nGitHub user seed:");
			console.log(`   Email: ${githubEmail}`);
			console.log(`   API keys seeded: ${seedApiKeys.length}`);
		}
	} catch (error) {
		console.error("Failed to seed dev user:", error);
		process.exit(1);
	} finally {
		await queryClient.end();
	}
}

seedDevUser();
