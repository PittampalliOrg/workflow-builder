/**
 * Social OAuth sign-in for the SvelteKit app.
 *
 * Handles user creation/lookup in the shared DB, then proxies JWT token
 * generation through the Next.js app (which owns the RS256 signing key).
 */
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { users, userIdentities, platforms, projects, projectMembers } from '$lib/server/db/schema';
import { generateId } from '$lib/server/utils/id';
import { generateTokens } from '$lib/server/auth';

const DEFAULT_PLATFORM_ID = 'default-platform';

export interface SocialProfile {
	email: string;
	name: string | null;
	image: string | null;
	provider: 'GITHUB' | 'GOOGLE';
}

export interface AuthResult {
	accessToken: string;
	refreshToken: string;
	user: {
		id: string;
		email: string;
		name: string | null;
		image: string | null;
		projectSlug: string;
	};
}

/**
 * Sign in or create a user from a social OAuth profile.
 * Creates the user in the shared DB, then obtains JWT tokens by calling
 * the Next.js app's internal token generation.
 */
export async function signInSocial(profile: SocialProfile): Promise<AuthResult> {
	if (!db) throw new Error('Database not configured');

	// Find or create user
	const [existingUser] = await db
		.select()
		.from(users)
		.where(eq(users.email, profile.email))
		.limit(1);

	let userId: string;
	let userName: string | null;
	let userImage: string | null;
	let platformId: string | null = null;

	if (existingUser) {
		userId = existingUser.id;
		userName = existingUser.name;
		userImage = existingUser.image;
		platformId = existingUser.platformId;

		// Update image if social provides one and we don't have it
		if (profile.image && !existingUser.image) {
			await db
				.update(users)
				.set({ image: profile.image, updatedAt: new Date() })
				.where(eq(users.id, userId));
			userImage = profile.image;
		}

		// Ensure identity exists
		const [existingIdentity] = await db
			.select()
			.from(userIdentities)
			.where(eq(userIdentities.userId, userId))
			.limit(1);

		if (!existingIdentity) {
			await db.insert(userIdentities).values({
				userId,
				email: profile.email,
				provider: profile.provider,
				firstName: profile.name?.split(' ')[0] || null,
				lastName: profile.name?.split(' ').slice(1).join(' ') || null,
				tokenVersion: 0,
				verified: true
			});
		}
	} else {
		// Create new user
		userId = generateId();
		userName = profile.name;
		userImage = profile.image;
		const now = new Date();

		// Get or create default platform
		const platform = await getOrCreateDefaultPlatform();
		platformId = platform.id;

		await db.insert(users).values({
			id: userId,
			name: profile.name,
			email: profile.email,
			emailVerified: true,
			image: profile.image,
			createdAt: now,
			updatedAt: now,
			platformId: platform.id,
			platformRole: 'MEMBER',
			status: 'ACTIVE'
		});

		await db.insert(userIdentities).values({
			userId,
			email: profile.email,
			provider: profile.provider,
			firstName: profile.name?.split(' ')[0] || null,
			lastName: profile.name?.split(' ').slice(1).join(' ') || null,
			tokenVersion: 0,
			verified: true
		});

		// Create default project
		await getOrCreateDefaultProject(userId, platform.id);
	}

	// Get platform and project for token payload. Existing users keep their
	// platform because signing keys are platform-scoped.
	let platform = platformId ? await getPlatformById(platformId) : null;
	if (!platform) {
		platform = await getOrCreateDefaultPlatform();
	}
	const project = await getOrCreateDefaultProject(userId, platform.id);

	// Get token version
	const [identity] = await db
		.select({ tokenVersion: userIdentities.tokenVersion })
		.from(userIdentities)
		.where(eq(userIdentities.userId, userId))
		.limit(1);

	const tokenVersion = identity?.tokenVersion ?? 0;

	// Generate JWT tokens directly using the RS256 signing key
	const tokens = await generateTokens(userId, profile.email, platform.id, project.id, tokenVersion);

	return {
		...tokens,
		user: {
			id: userId,
			email: profile.email,
			name: userName,
			image: userImage,
			projectSlug: 'default'
		}
	};
}

async function getPlatformById(platformId: string) {
	const [platform] = await db!
		.select()
		.from(platforms)
		.where(eq(platforms.id, platformId))
		.limit(1);
	return platform ?? null;
}

async function getOrCreateDefaultPlatform() {
	const [existing] = await db!
		.select()
		.from(platforms)
		.where(eq(platforms.id, DEFAULT_PLATFORM_ID))
		.limit(1);
	if (existing) return existing;

	const now = new Date();
	const [platform] = await db!
		.insert(platforms)
		.values({
			id: DEFAULT_PLATFORM_ID,
			name: 'Default Platform',
			createdAt: now,
			updatedAt: now
		})
		.returning();
	return platform;
}

async function getOrCreateDefaultProject(userId: string, platformId: string) {
	const [existing] = await db!
		.select()
		.from(projects)
		.where(eq(projects.ownerId, userId))
		.limit(1);

	if (existing) return existing;

	const id = generateId();
	const externalId = generateId();
	const now = new Date();
	const [project] = await db!
		.insert(projects)
		.values({
			id,
			ownerId: userId,
			displayName: 'Default Project',
			externalId,
			platformId,
			createdAt: now,
			updatedAt: now
		})
		.returning();

	// Add user as project admin
	await db!.insert(projectMembers).values({
		userId,
		projectId: id,
		role: 'ADMIN'
	});

	return project;
}

// generateTokens is imported from $lib/server/auth
