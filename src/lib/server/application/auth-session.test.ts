import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	ApplicationAuthSessionService,
	type AuthAccessTokenVerifier,
	type AuthSessionReader,
	type AuthTokenRefresher,
} from "$lib/server/application/auth-session";

describe("ApplicationAuthSessionService", () => {
	it("delegates session lookup to the session reader port", async () => {
		const request = new Request("http://localhost/api/v1/auth/session");
		const cookies = {
			get: vi.fn(() => undefined),
			set: vi.fn(),
		};
		const sessions: AuthSessionReader = {
			getSession: vi.fn(async () => ({
				user: {
					id: "user-1",
					email: "user@example.com",
					name: "User",
					image: null,
					platformId: "platform-1",
					projectId: "project-1",
				},
			})),
		};
		const service = new ApplicationAuthSessionService({
			sessions,
			tokens: createTokenRefresher(),
			accessTokens: createAccessTokenVerifier(),
		});

		await expect(service.getSession({ request, cookies })).resolves.toEqual({
			user: expect.objectContaining({ id: "user-1" }),
		});
		expect(sessions.getSession).toHaveBeenCalledWith({ request, cookies });
	});

	it("refreshes non-empty refresh tokens through the token refresher port", async () => {
		const tokens = createTokenRefresher({
			refreshTokens: vi.fn(async () => ({
				accessToken: "access-1",
				refreshToken: "refresh-2",
			})),
		});
		const service = new ApplicationAuthSessionService({
			sessions: createSessionReader(),
			tokens,
			accessTokens: createAccessTokenVerifier(),
		});

		await expect(
			service.refreshTokens({ refreshToken: " refresh-1 " }),
		).resolves.toEqual({
			accessToken: "access-1",
			refreshToken: "refresh-2",
		});
		expect(tokens.refreshTokens).toHaveBeenCalledWith("refresh-1");
	});

	it("does not call the token refresher for empty refresh tokens", async () => {
		const tokens = createTokenRefresher();
		const service = new ApplicationAuthSessionService({
			sessions: createSessionReader(),
			tokens,
			accessTokens: createAccessTokenVerifier(),
		});

		await expect(service.refreshTokens({ refreshToken: " " })).resolves.toBeNull();
		expect(tokens.refreshTokens).not.toHaveBeenCalled();
	});

	it("verifies non-empty access tokens through the access token verifier port", async () => {
		const accessTokens = createAccessTokenVerifier({
				verifyAccessToken: vi.fn(async () => ({
					sub: "user-1",
					projectId: "project-1",
					type: "access" as const,
				})),
		});
		const service = new ApplicationAuthSessionService({
			sessions: createSessionReader(),
			tokens: createTokenRefresher(),
			accessTokens,
		});

		await expect(
			service.verifyAccessToken({ token: " access-1 " }),
		).resolves.toEqual({
			sub: "user-1",
			projectId: "project-1",
			type: "access",
		});
		expect(accessTokens.verifyAccessToken).toHaveBeenCalledWith("access-1");
	});

	it("keeps the legacy auth compatibility module free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../auth.ts"),
			"utf8",
		);

		expect(source).toContain("$lib/server/application/adapters/auth-session");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("signingKeys");
		expect(source).not.toContain("userIdentities");
	});
});

function createSessionReader(
	overrides: Partial<AuthSessionReader> = {},
): AuthSessionReader {
	return {
		getSession: vi.fn(async () => null),
		...overrides,
	};
}

function createTokenRefresher(
	overrides: Partial<AuthTokenRefresher> = {},
): AuthTokenRefresher {
	return {
		refreshTokens: vi.fn(async () => null),
		...overrides,
	};
}

function createAccessTokenVerifier(
	overrides: Partial<AuthAccessTokenVerifier> = {},
): AuthAccessTokenVerifier {
	return {
		verifyAccessToken: vi.fn(async () => null),
		...overrides,
	};
}
