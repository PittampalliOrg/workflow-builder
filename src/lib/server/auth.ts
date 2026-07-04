/**
 * Auth compatibility surface for SvelteKit Workflow Builder.
 *
 * The DB-backed implementation lives in the auth-session application adapter.
 * Keep this module free of direct infrastructure imports so legacy callers do
 * not bypass the application boundary.
 */
import {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	shouldUseSecureCookies,
} from "$lib/server/auth-cookies";
import {
	getSessionWithPostgresAuth,
	refreshTokensWithPostgresAuth,
	verifyAccessTokenWithPostgresAuth,
	verifyRefreshTokenWithPostgresAuth,
} from "$lib/server/application/adapters/auth-session";
import {
	generateTokens,
	type TokenPayload,
} from "$lib/server/auth-jwt";

export {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	shouldUseSecureCookies,
} from "$lib/server/auth-cookies";
export { generateTokens, type TokenPayload } from "$lib/server/auth-jwt";

export type SessionUser = {
	id: string;
	name: string | null;
	email: string;
	image: string | null;
	platformId: string;
	projectId: string;
};

export type Session = {
	user: SessionUser;
};

/**
 * Verify an access token.
 */
export async function verifyAccessToken(token: string): Promise<TokenPayload | null> {
	return verifyAccessTokenWithPostgresAuth(token);
}

/**
 * Verify a refresh token.
 */
export async function verifyRefreshToken(token: string): Promise<TokenPayload | null> {
	return verifyRefreshTokenWithPostgresAuth(token);
}

/**
 * Refresh tokens: verify the refresh token, check token version, issue new pair.
 */
export async function refreshTokens(
	refreshToken: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
	return refreshTokensWithPostgresAuth(refreshToken);
}

/**
 * Extract session from a request. If the access token is expired but
 * a valid refresh token exists, automatically refreshes and returns
 * new tokens via the setCookies callback.
 */
export async function getSession(
	request: Request,
	cookies?: {
		get(name: string): string | undefined;
		set(name: string, value: string, opts: { path: string; [key: string]: unknown }): void;
	}
): Promise<Session | null> {
	return getSessionWithPostgresAuth({ request, cookies });
}
