import { scryptSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	ApplicationAuthSignInService,
	type AuthSignInRepository,
	type AuthTokenIssuer,
} from "$lib/server/application/auth-sign-in";

function makeRepository(
	overrides: Partial<AuthSignInRepository> = {},
): AuthSignInRepository {
	return {
		isAvailable: vi.fn(() => true),
		findUserByEmail: vi.fn(async () => null),
		findIdentityByUserId: vi.fn(async () => null),
		updateUserImage: vi.fn(async () => {}),
		createSocialIdentity: vi.fn(async () => {}),
		createUser: vi.fn(async () => {}),
		findAnyPlatform: vi.fn(async () => ({ id: "platform-1" })),
		getPlatformById: vi.fn(async (id: string) => ({ id })),
		findProjectByOwnerId: vi.fn(async () => ({ id: "project-1" })),
		getOrCreateDefaultPlatform: vi.fn(async () => ({ id: "default-platform" })),
		getOrCreateDefaultProject: vi.fn(async () => ({ id: "project-1" })),
		getIdentityTokenVersion: vi.fn(async () => 0),
		...overrides,
	};
}

function makeTokens(): AuthTokenIssuer {
	return {
		issue: vi.fn(async () => ({
			accessToken: "access-token",
			refreshToken: "refresh-token",
		})),
	};
}

function makeService(
	repository: AuthSignInRepository = makeRepository(),
	tokens: AuthTokenIssuer = makeTokens(),
) {
	return new ApplicationAuthSignInService({
		repository,
		tokens,
		ids: { generate: () => "generated-user-id" },
	});
}

function legacyScryptHash(password: string): string {
	const salt = "salt";
	return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

describe("ApplicationAuthSignInService", () => {
	it("rejects missing password credentials before touching persistence", async () => {
		const repository = makeRepository();
		const service = makeService(repository);

		await expect(service.signInWithPassword({ email: "ada@example.com" })).resolves.toEqual({
			ok: false,
			status: 400,
			message: "Email and password are required",
		});

		expect(repository.findUserByEmail).not.toHaveBeenCalled();
	});

	it("keeps password sign-in idempotent when platform/project fallbacks are missing", async () => {
		const repository = makeRepository({
			findUserByEmail: vi.fn(async () => ({
				id: "user-1",
				email: "ada@example.com",
				name: "Ada",
				image: null,
				platformId: null,
			})),
			findIdentityByUserId: vi.fn(async () => ({
				password: legacyScryptHash("correct"),
				tokenVersion: 3,
			})),
			findAnyPlatform: vi.fn(async () => ({ id: "platform-1" })),
			findProjectByOwnerId: vi.fn(async () => null),
			getOrCreateDefaultProject: vi.fn(async () => ({ id: "should-not-create" })),
		});
		const tokens = makeTokens();
		const service = makeService(repository, tokens);

		const result = await service.signInWithPassword({
			email: " ada@example.com ",
			password: "correct",
		});

		expect(result).toEqual({
			ok: true,
			accessToken: "access-token",
			refreshToken: "refresh-token",
			user: {
				id: "user-1",
				email: "ada@example.com",
				name: "Ada",
				image: null,
			},
		});
		expect(tokens.issue).toHaveBeenCalledWith({
			userId: "user-1",
			email: "ada@example.com",
			platformId: "platform-1",
			projectId: "default",
			tokenVersion: 3,
		});
		expect(repository.getOrCreateDefaultProject).not.toHaveBeenCalled();
	});

	it("creates social-auth user, identity, default project, and token payload", async () => {
		const repository = makeRepository({
			findUserByEmail: vi.fn(async () => null),
			getIdentityTokenVersion: vi.fn(async () => 0),
		});
		const tokens = makeTokens();
		const service = makeService(repository, tokens);

		const result = await service.signInSocial({
			email: "grace@example.com",
			name: "Grace Hopper",
			image: "https://example.com/grace.png",
			provider: "GITHUB",
		});

		expect(repository.createUser).toHaveBeenCalledWith({
			id: "generated-user-id",
			email: "grace@example.com",
			name: "Grace Hopper",
			image: "https://example.com/grace.png",
			platformId: "default-platform",
		});
		expect(repository.createSocialIdentity).toHaveBeenCalledWith({
			userId: "generated-user-id",
			email: "grace@example.com",
			provider: "GITHUB",
			firstName: "Grace",
			lastName: "Hopper",
		});
		expect(repository.getOrCreateDefaultProject).toHaveBeenCalledWith(
			"generated-user-id",
			"default-platform",
		);
		expect(tokens.issue).toHaveBeenCalledWith({
			userId: "generated-user-id",
			email: "grace@example.com",
			platformId: "default-platform",
			projectId: "project-1",
			tokenVersion: 0,
		});
		expect(result.user).toEqual({
			id: "generated-user-id",
			email: "grace@example.com",
			name: "Grace Hopper",
			image: "https://example.com/grace.png",
			projectSlug: "default",
		});
	});
});
