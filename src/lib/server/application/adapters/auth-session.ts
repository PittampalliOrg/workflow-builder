import { jwtVerify, importSPKI } from "jose";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { signingKeys, users, userIdentities } from "$lib/server/db/schema";
import {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	shouldUseSecureCookies,
} from "$lib/server/auth-cookies";
import {
	generateTokens,
	type TokenPayload,
} from "$lib/server/auth-jwt";
import type {
	AuthAccessTokenVerifier,
	AuthCookieStore,
	AuthSessionReader,
	AuthTokenRefresher,
} from "$lib/server/application/auth-session";

export class LegacyAuthSessionReader implements AuthSessionReader {
	getSession(input: { request: Request; cookies?: AuthCookieStore }) {
		return getSessionWithPostgresAuth(input);
	}
}

export class LegacyAuthTokenRefresher implements AuthTokenRefresher {
	refreshTokens(refreshToken: string) {
		return refreshTokensWithPostgresAuth(refreshToken);
	}
}

export class LegacyAuthAccessTokenVerifier implements AuthAccessTokenVerifier {
	verifyAccessToken(token: string) {
		return verifyAccessTokenWithPostgresAuth(token);
	}
}

/**
 * Get the RS256 public key for a platform from the signing_keys table.
 */
async function getPublicKey(platformId: string) {
	if (!db) return null;

	const [key] = await db
		.select({ publicKey: signingKeys.publicKey })
		.from(signingKeys)
		.where(eq(signingKeys.platformId, platformId))
		.limit(1);

	if (!key?.publicKey) return null;
	return importSPKI(key.publicKey, "RS256");
}

/**
 * Verify a JWT token (access or refresh) and return the payload.
 */
async function verifyToken(
	token: string,
	expectedType: "access" | "refresh",
): Promise<TokenPayload | null> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const payloadStr = Buffer.from(parts[1], "base64url").toString();
		const rawPayload = JSON.parse(payloadStr);
		const platformId = rawPayload.platformId;

		if (!platformId) return null;

		const publicKey = await getPublicKey(platformId);
		if (!publicKey) return null;

		const { payload } = await jwtVerify(token, publicKey, {
			algorithms: ["RS256"],
		});

		const tokenPayload = payload as unknown as TokenPayload;

		if (tokenPayload.type !== expectedType) return null;

		return tokenPayload;
	} catch {
		return null;
	}
}

export async function verifyAccessTokenWithPostgresAuth(
	token: string,
): Promise<TokenPayload | null> {
	return verifyToken(token, "access");
}

export async function verifyRefreshTokenWithPostgresAuth(
	token: string,
): Promise<TokenPayload | null> {
	return verifyToken(token, "refresh");
}

export async function refreshTokensWithPostgresAuth(
	refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
	const payload = await verifyRefreshTokenWithPostgresAuth(refreshToken);
	if (!payload) return null;

	if (!db) return null;

	// Check current token version matches.
	const [identity] = await db
		.select({ tokenVersion: userIdentities.tokenVersion })
		.from(userIdentities)
		.where(eq(userIdentities.userId, payload.sub))
		.limit(1);

	if (!identity) return null;

	// Token version mismatch means token was revoked.
	if (identity.tokenVersion !== payload.tokenVersion) return null;

	return generateTokens(
		payload.sub,
		payload.email,
		payload.platformId,
		payload.projectId,
		identity.tokenVersion,
	);
}

/**
 * Build a session from a verified token payload.
 */
async function buildSession(payload: TokenPayload) {
	if (!db) {
		return {
			user: {
				id: payload.sub,
				email: payload.email,
				name: null,
				image: null,
				platformId: payload.platformId,
				projectId: payload.projectId,
			},
		};
	}

	const [user] = await db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			image: users.image,
		})
		.from(users)
		.where(eq(users.id, payload.sub))
		.limit(1);

	if (!user) return null;

	return {
		user: {
			id: user.id,
			email: user.email ?? payload.email,
			name: user.name,
			image: user.image,
			platformId: payload.platformId,
			projectId: payload.projectId,
		},
	};
}

/**
 * Extract session from a request. If the access token is expired but
 * a valid refresh token exists, automatically refreshes and returns
 * new tokens via the setCookies callback.
 */
export async function getSessionWithPostgresAuth(input: {
	request: Request;
	cookies?: AuthCookieStore;
}) {
	const { request, cookies } = input;

	// Check Authorization header first.
	const authHeader = request.headers.get("authorization");
	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		const payload = await verifyAccessTokenWithPostgresAuth(token);
		if (payload) return buildSession(payload);
	}

	// Check access token cookie.
	const accessToken = cookies?.get(ACCESS_TOKEN_COOKIE);
	if (accessToken) {
		const payload = await verifyAccessTokenWithPostgresAuth(accessToken);
		if (payload) return buildSession(payload);
	}

	// Access token missing or expired; try refresh token.
	const refreshCookie = cookies?.get(REFRESH_TOKEN_COOKIE);
	if (refreshCookie && cookies) {
		const newTokens = await refreshTokensWithPostgresAuth(refreshCookie);
		if (newTokens) {
			cookies.set(ACCESS_TOKEN_COOKIE, newTokens.accessToken, {
				path: "/",
				httpOnly: true,
				secure: shouldUseSecureCookies(request),
				sameSite: "lax",
				maxAge: 60 * 60,
			});
			cookies.set(REFRESH_TOKEN_COOKIE, newTokens.refreshToken, {
				path: "/",
				httpOnly: true,
				secure: shouldUseSecureCookies(request),
				sameSite: "lax",
				maxAge: 60 * 60 * 24 * 7,
			});

			// Verify the new access token to build session.
			const payload = await verifyAccessTokenWithPostgresAuth(
				newTokens.accessToken,
			);
			if (payload) return buildSession(payload);
		}
	}

	return null;
}
