import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { db } from '$lib/server/db';
import { appConnections, platformOauthApps } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
	decryptObject,
	encryptObject,
	type EncryptedObject
} from '$lib/server/security/encryption';
import { decryptString } from '$lib/server/security/encryption';

const AP_PREFIX = '@activepieces/piece-';
const REFRESH_THRESHOLD_SECONDS = 5 * 60; // Refresh 5 minutes before expiry

function expandPieceNameCandidates(name: string): string[] {
	const candidates = new Set([name]);
	if (name.startsWith(AP_PREFIX)) candidates.add(name.slice(AP_PREFIX.length));
	else candidates.add(`${AP_PREFIX}${name}`);
	return Array.from(candidates);
}

function isTokenExpired(token: Record<string, unknown>): boolean {
	const claimedAt = typeof token.claimed_at === 'number' ? token.claimed_at : 0;
	const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
	if (!claimedAt) return false;
	const now = Math.floor(Date.now() / 1000);
	return now + REFRESH_THRESHOLD_SECONDS >= claimedAt + expiresIn;
}

function resolveClientSecret(value: unknown): string {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as EncryptedObject;
			if (parsed && typeof parsed === 'object' && 'iv' in parsed && 'data' in parsed) {
				return decryptString(parsed);
			}
		} catch {
			return value;
		}
		return value;
	}
	if (value && typeof value === 'object' && !Array.isArray(value) && 'iv' in value && 'data' in value) {
		return decryptString(value as EncryptedObject);
	}
	throw new Error('Cannot resolve client secret');
}

async function refreshOAuth2Token(
	token: Record<string, unknown>,
	pieceName: string
): Promise<Record<string, unknown> | null> {
	const refreshToken = token.refresh_token as string | undefined;
	const tokenUrl = token.token_url as string | undefined;
	if (!refreshToken || !tokenUrl) return null;

	// Get client credentials from platform OAuth apps
	const candidates = expandPieceNameCandidates(pieceName);
	const oauthApps = db
		? await db
				.select()
				.from(platformOauthApps)
				.where(inArray(platformOauthApps.pieceName, candidates))
				.limit(1)
		: [];

	if (oauthApps.length === 0) return null;

	const oauthApp = oauthApps[0];
	const clientId = (token.client_id as string) || oauthApp.clientId;
	let clientSecret: string;
	try {
		clientSecret = resolveClientSecret(oauthApp.clientSecret);
	} catch {
		return null;
	}

	const authMethod = (token.authorization_method as string) || 'BODY';
	const body: Record<string, string> = {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	};

	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded',
	};

	if (authMethod === 'HEADER') {
		headers['Authorization'] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
	} else {
		body.client_id = clientId;
		body.client_secret = clientSecret;
	}

	try {
		const response = await fetch(tokenUrl, {
			method: 'POST',
			headers,
			body: new URLSearchParams(body).toString(),
			signal: AbortSignal.timeout(20000),
		});

		if (!response.ok) {
			console.error(`[OAuth2 Refresh] Token refresh failed: HTTP ${response.status}`);
			return null;
		}

		const data = (await response.json()) as Record<string, unknown>;

		// Merge refreshed token with existing token data (don't overwrite refresh_token if not returned)
		return {
			...token,
			access_token: data.access_token ?? token.access_token,
			token_type: data.token_type ?? token.token_type,
			expires_in: data.expires_in ?? token.expires_in,
			scope: data.scope ?? token.scope,
			refresh_token: data.refresh_token ?? token.refresh_token,
			claimed_at: Math.floor(Date.now() / 1000),
			data: { ...(token.data as Record<string, unknown> ?? {}), ...(data.data as Record<string, unknown> ?? {}) },
		};
	} catch (err) {
		console.error('[OAuth2 Refresh] Failed:', err);
		return null;
	}
}

/**
 * GET /api/internal/connections/[externalId]/decrypt
 *
 * Decrypts a connection's value by externalId.
 * For OAuth2 connections, auto-refreshes expired tokens.
 *
 * Called by function-router to retrieve decrypted credentials at execution time.
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	if (!db) {
		return error(503, 'Database not configured');
	}

	const { externalId } = params;

	const [connection] = await db
		.select()
		.from(appConnections)
		.where(eq(appConnections.externalId, externalId))
		.limit(1);

	if (!connection) {
		return error(404, 'Connection not found');
	}

	let decryptedValue = decryptObject(connection.value as EncryptedObject);
	const isOAuth2 = connection.type === 'OAUTH2' || connection.type === 'PLATFORM_OAUTH2' || connection.type === 'CLOUD_OAUTH2';

	// Debug: log decrypted value shape for credential troubleshooting
	const dv = decryptedValue as Record<string, unknown>;
	const secretTextLen = typeof dv?.secret_text === 'string' ? dv.secret_text.length : 0;
	console.log(
		`[Decrypt API] ${externalId}: type=${connection.type}, ` +
		`valueType=${dv?.type}, hasAccessToken=${!!dv?.access_token}, ` +
		`accessTokenLen=${typeof dv?.access_token === 'string' ? dv.access_token.length : 'N/A'}, ` +
		`hasRefreshToken=${!!dv?.refresh_token}, ` +
		`claimedAt=${dv?.claimed_at}, expiresIn=${dv?.expires_in}, ` +
		`secretTextLen=${secretTextLen}, ` +
		`valueKeys=${Object.keys(dv || {}).join(',')}`
	);

	// Fix: if the connection type is OAuth2 but the stored value is SECRET_TEXT format,
	// restructure it so AP pieces can use context.auth.access_token.
	// This handles connections where the OAuth2 token was stored as { secret_text: "..." }
	// instead of the full OAuth2 token object with access_token, refresh_token, etc.
	if (isOAuth2 && dv?.secret_text && !dv?.access_token) {
		const secretText = dv.secret_text as string;
		// Try parsing as JSON in case it's a stringified OAuth2 token object
		try {
			const parsed = JSON.parse(secretText) as Record<string, unknown>;
			if (parsed && typeof parsed === 'object' && parsed.access_token) {
				console.log(`[Decrypt API] Parsed SECRET_TEXT JSON as OAuth2 for ${externalId}`);
				decryptedValue = { ...parsed, type: parsed.type || connection.type };
			} else {
				// Plain access token string
				console.log(`[Decrypt API] Using SECRET_TEXT as access_token for ${externalId}`);
				(decryptedValue as Record<string, unknown>).access_token = secretText;
				(decryptedValue as Record<string, unknown>).type = connection.type;
			}
		} catch {
			// Not JSON — treat secret_text as the raw access token
			console.log(`[Decrypt API] Using SECRET_TEXT as access_token for ${externalId}`);
			(decryptedValue as Record<string, unknown>).access_token = secretText;
			(decryptedValue as Record<string, unknown>).type = connection.type;
		}
	}

	// Auto-refresh expired OAuth2 tokens
	if (isOAuth2 && typeof decryptedValue === 'object' && decryptedValue !== null) {
		const tokenObj = decryptedValue as Record<string, unknown>;
		if (isTokenExpired(tokenObj)) {
			console.log(`[OAuth2 Refresh] Token expired for ${connection.pieceName}, refreshing...`);
			const refreshed = await refreshOAuth2Token(tokenObj, connection.pieceName);
			if (refreshed) {
				// Save refreshed token back to database
				const encrypted = encryptObject(refreshed);
				await db
					.update(appConnections)
					.set({ value: encrypted, updatedAt: new Date() })
					.where(eq(appConnections.id, connection.id));
				decryptedValue = refreshed;
				console.log(`[OAuth2 Refresh] Token refreshed for ${connection.pieceName}`);
			} else {
				console.warn(`[OAuth2 Refresh] Failed to refresh token for ${connection.pieceName}`);
			}
		}
	}

	// For PLATFORM_OAUTH2: inject client_secret and expiry_date so AP pieces
	// (which create their own OAuth2Client) can refresh tokens and detect expiry.
	if (connection.type === 'PLATFORM_OAUTH2' && typeof decryptedValue === 'object' && decryptedValue !== null) {
		const tokenObj = decryptedValue as Record<string, unknown>;

		// Inject client_secret from platform_oauth_apps (not stored in the token value)
		if (!tokenObj.client_secret && tokenObj.client_id) {
			const candidates = expandPieceNameCandidates(connection.pieceName);
			const oauthApps = await db
				.select()
				.from(platformOauthApps)
				.where(inArray(platformOauthApps.pieceName, candidates))
				.limit(1);
			if (oauthApps.length > 0) {
				try {
					tokenObj.client_secret = resolveClientSecret(oauthApps[0].clientSecret);
					console.log(`[Decrypt API] Injected client_secret for ${connection.pieceName}`);
				} catch {
					console.warn(`[Decrypt API] Failed to resolve client_secret for ${connection.pieceName}`);
				}
			}
		}

		// Compute expiry_date (ms since epoch) from claimed_at + expires_in.
		// Google's OAuth2Client uses expiry_date to decide whether to refresh.
		const claimedAt = typeof tokenObj.claimed_at === 'number' ? tokenObj.claimed_at : 0;
		const expiresIn = typeof tokenObj.expires_in === 'number' ? tokenObj.expires_in : 3600;
		if (claimedAt && !tokenObj.expiry_date) {
			tokenObj.expiry_date = (claimedAt + expiresIn) * 1000; // convert to ms
		}
	}

	return json({
		id: connection.id,
		externalId: connection.externalId,
		type: connection.type,
		pieceName: connection.pieceName,
		value: decryptedValue
	});
};
