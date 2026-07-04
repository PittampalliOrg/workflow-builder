import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	platforms,
	projectMembers,
	projects,
	userIdentities,
	users,
} from "$lib/server/db/schema";
import type {
	AuthIdentityRecord,
	AuthSignInRepository,
	AuthSocialIdentityInput,
	AuthTokenIssuer,
	AuthUserCreateInput,
} from "$lib/server/application/auth-sign-in";
import { generateTokens } from "$lib/server/auth-jwt";
import { generateId } from "$lib/server/utils/id";

const DEFAULT_PLATFORM_ID = "default-platform";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export class DateAuthIdGenerator {
	generate(): string {
		return generateId();
	}
}

export class JwtAuthTokenIssuer implements AuthTokenIssuer {
	async issue(input: {
		userId: string;
		email: string;
		platformId: string;
		projectId: string;
		tokenVersion: number;
	}): Promise<{ accessToken: string; refreshToken: string }> {
		return generateTokens(
			input.userId,
			input.email,
			input.platformId,
			input.projectId,
			input.tokenVersion,
		);
	}
}

export class PostgresAuthSignInRepository implements AuthSignInRepository {
	isAvailable(): boolean {
		return Boolean(db);
	}

	async findUserByEmail(email: string) {
		const [user] = await requireDb()
			.select({
				id: users.id,
				email: users.email,
				name: users.name,
				image: users.image,
				platformId: users.platformId,
			})
			.from(users)
			.where(eq(users.email, email))
			.limit(1);
		return user ?? null;
	}

	async findIdentityByUserId(userId: string): Promise<AuthIdentityRecord | null> {
		const [identity] = await requireDb()
			.select({
				password: userIdentities.password,
				tokenVersion: userIdentities.tokenVersion,
			})
			.from(userIdentities)
			.where(eq(userIdentities.userId, userId))
			.limit(1);
		return identity ?? null;
	}

	async updateUserImage(userId: string, image: string): Promise<void> {
		await requireDb()
			.update(users)
			.set({ image, updatedAt: new Date() })
			.where(eq(users.id, userId));
	}

	async createSocialIdentity(input: AuthSocialIdentityInput): Promise<void> {
		await requireDb().insert(userIdentities).values({
			userId: input.userId,
			email: input.email,
			provider: input.provider,
			firstName: input.firstName,
			lastName: input.lastName,
			tokenVersion: 0,
			verified: true,
		});
	}

	async createUser(input: AuthUserCreateInput): Promise<void> {
		const now = new Date();
		await requireDb().insert(users).values({
			id: input.id,
			name: input.name,
			email: input.email,
			emailVerified: true,
			image: input.image,
			createdAt: now,
			updatedAt: now,
			platformId: input.platformId,
			platformRole: "MEMBER",
			status: "ACTIVE",
		});
	}

	async findAnyPlatform() {
		const [platform] = await requireDb()
			.select({ id: platforms.id })
			.from(platforms)
			.limit(1);
		return platform ?? null;
	}

	async getPlatformById(platformId: string) {
		const [platform] = await requireDb()
			.select({ id: platforms.id })
			.from(platforms)
			.where(eq(platforms.id, platformId))
			.limit(1);
		return platform ?? null;
	}

	async findProjectByOwnerId(userId: string) {
		const [project] = await requireDb()
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.ownerId, userId))
			.limit(1);
		return project ?? null;
	}

	async getOrCreateDefaultPlatform() {
		const [existing] = await requireDb()
			.select({ id: platforms.id })
			.from(platforms)
			.where(eq(platforms.id, DEFAULT_PLATFORM_ID))
			.limit(1);
		if (existing) return existing;

		const now = new Date();
		const [platform] = await requireDb()
			.insert(platforms)
			.values({
				id: DEFAULT_PLATFORM_ID,
				name: "Default Platform",
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: platforms.id });
		return platform;
	}

	async getOrCreateDefaultProject(userId: string, platformId: string) {
		const existing = await this.findProjectByOwnerId(userId);
		if (existing) return existing;

		const id = generateId();
		const externalId = generateId();
		const now = new Date();
		const [project] = await requireDb()
			.insert(projects)
			.values({
				id,
				ownerId: userId,
				displayName: "Default Project",
				externalId,
				platformId,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: projects.id });

		await requireDb().insert(projectMembers).values({
			userId,
			projectId: id,
			role: "ADMIN",
		});

		return project;
	}

	async getIdentityTokenVersion(userId: string): Promise<number> {
		const [identity] = await requireDb()
			.select({ tokenVersion: userIdentities.tokenVersion })
			.from(userIdentities)
			.where(eq(userIdentities.userId, userId))
			.limit(1);
		return identity?.tokenVersion ?? 0;
	}
}
