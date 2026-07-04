/**
 * Auth Service for SvelteKit Workflow Builder
 *
 * Verifies JWT tokens, handles token refresh, builds sessions.
 * Tokens use RS256 signed with the shared JWT_SIGNING_KEY.
 */
import { jwtVerify, importSPKI, importPKCS8, SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { signingKeys, users, userIdentities } from '$lib/server/db/schema';
import { env } from '$env/dynamic/private';
import {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	shouldUseSecureCookies,
} from "$lib/server/auth-cookies";

export {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
	shouldUseSecureCookies,
} from "$lib/server/auth-cookies";

export type TokenPayload = {
	sub: string; // userId
	email: string;
	platformId: string;
	projectId: string;
	tokenVersion: number;
	type: 'access' | 'refresh';
};

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
	return importSPKI(key.publicKey, 'RS256');
}

/**
 * Verify a JWT token (access or refresh) and return the payload.
 */
async function verifyToken(token: string, expectedType: 'access' | 'refresh'): Promise<TokenPayload | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;

		const payloadStr = Buffer.from(parts[1], 'base64url').toString();
		const rawPayload = JSON.parse(payloadStr);
		const platformId = rawPayload.platformId;

		if (!platformId) return null;

		const publicKey = await getPublicKey(platformId);
		if (!publicKey) return null;

		const { payload } = await jwtVerify(token, publicKey, {
			algorithms: ['RS256']
		});

		const tokenPayload = payload as unknown as TokenPayload;

		if (tokenPayload.type !== expectedType) return null;

		return tokenPayload;
	} catch {
		return null;
	}
}

/**
 * Verify an access token.
 */
export async function verifyAccessToken(token: string): Promise<TokenPayload | null> {
	return verifyToken(token, 'access');
}

/**
 * Verify a refresh token.
 */
export async function verifyRefreshToken(token: string): Promise<TokenPayload | null> {
	return verifyToken(token, 'refresh');
}

/**
 * Generate new access + refresh token pair using the RS256 signing key.
 */
export async function generateTokens(
	userId: string,
	email: string,
	platformId: string,
	projectId: string,
	tokenVersion: number
): Promise<{ accessToken: string; refreshToken: string }> {
	const keyPem = env.JWT_SIGNING_KEY;
	if (!keyPem) throw new Error('JWT_SIGNING_KEY not configured');

	const privateKey = await importPKCS8(keyPem, 'RS256');

	const accessToken = await new SignJWT({
		sub: userId,
		email,
		platformId,
		projectId,
		tokenVersion,
		type: 'access'
	} satisfies TokenPayload)
		.setProtectedHeader({ alg: 'RS256' })
		.setIssuedAt()
		.setExpirationTime(env.JWT_ACCESS_TOKEN_EXPIRY || '1h')
		.sign(privateKey);

	const refreshToken = await new SignJWT({
		sub: userId,
		email,
		platformId,
		projectId,
		tokenVersion,
		type: 'refresh'
	} satisfies TokenPayload)
		.setProtectedHeader({ alg: 'RS256' })
		.setIssuedAt()
		.setExpirationTime(env.JWT_REFRESH_TOKEN_EXPIRY || '7d')
		.sign(privateKey);

	return { accessToken, refreshToken };
}

/**
 * Refresh tokens: verify the refresh token, check token version, issue new pair.
 */
export async function refreshTokens(
	refreshToken: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
	const payload = await verifyRefreshToken(refreshToken);
	if (!payload) return null;

	if (!db) return null;

	// Check current token version matches
	const [identity] = await db
		.select({ tokenVersion: userIdentities.tokenVersion })
		.from(userIdentities)
		.where(eq(userIdentities.userId, payload.sub))
		.limit(1);

	if (!identity) return null;

	// Token version mismatch means token was revoked
	if (identity.tokenVersion !== payload.tokenVersion) return null;

	return generateTokens(
		payload.sub,
		payload.email,
		payload.platformId,
		payload.projectId,
		identity.tokenVersion
	);
}

/**
 * Build a session from a verified token payload.
 */
async function buildSession(payload: TokenPayload): Promise<Session | null> {
	if (!db) {
		return {
			user: {
				id: payload.sub,
				email: payload.email,
				name: null,
				image: null,
				platformId: payload.platformId,
				projectId: payload.projectId
			}
		};
	}

	const [user] = await db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			image: users.image
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
			projectId: payload.projectId
		}
	};
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
	// Check Authorization header first
	const authHeader = request.headers.get('authorization');
	if (authHeader?.startsWith('Bearer ')) {
		const token = authHeader.slice(7);
		const payload = await verifyAccessToken(token);
		if (payload) return buildSession(payload);
	}

	// Check access token cookie
	const accessToken = cookies?.get(ACCESS_TOKEN_COOKIE);
	if (accessToken) {
		const payload = await verifyAccessToken(accessToken);
		if (payload) return buildSession(payload);
	}

	// Access token missing or expired — try refresh token
	const refreshCookie = cookies?.get(REFRESH_TOKEN_COOKIE);
	if (refreshCookie && cookies) {
		const newTokens = await refreshTokens(refreshCookie);
		if (newTokens) {
			// Set new cookies silently
			cookies.set(ACCESS_TOKEN_COOKIE, newTokens.accessToken, {
				path: '/',
				httpOnly: true,
				secure: shouldUseSecureCookies(request),
				sameSite: 'lax',
				maxAge: 60 * 60 // 1 hour
			});
			cookies.set(REFRESH_TOKEN_COOKIE, newTokens.refreshToken, {
				path: '/',
				httpOnly: true,
				secure: shouldUseSecureCookies(request),
				sameSite: 'lax',
				maxAge: 60 * 60 * 24 * 7 // 7 days
			});

			// Verify the new access token to build session
			const payload = await verifyAccessToken(newTokens.accessToken);
			if (payload) return buildSession(payload);
		}
	}

	return null;
}
