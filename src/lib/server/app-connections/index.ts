import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { appConnections, pieceMetadata, platformOauthApps } from '$lib/server/db/schema';
import { decryptObject, decryptString, encryptObject, type EncryptedObject } from '$lib/server/security/encryption';

const REFRESH_THRESHOLD_SECONDS = 5 * 60;

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
			if (parsed && typeof parsed === 'object' && 'iv' in parsed && 'data' in parsed) return decryptString(parsed);
		} catch { return value; }
		return value;
	}
	if (value && typeof value === 'object' && !Array.isArray(value) && 'iv' in value && 'data' in value) return decryptString(value as EncryptedObject);
	throw new Error('Cannot resolve client secret');
}

async function refreshOAuth2Token(token: Record<string, unknown>, pieceName: string): Promise<Record<string, unknown> | null> {
	const refreshToken = token.refresh_token as string | undefined;
	const tokenUrl = token.token_url as string | undefined;
	if (!refreshToken || !tokenUrl) return null;
	const candidates = [pieceName, pieceName.startsWith('@activepieces/piece-') ? pieceName : `@activepieces/piece-${pieceName}`];
	const oauthApps = db ? await db.select().from(platformOauthApps).where(inArray(platformOauthApps.pieceName, candidates)).limit(1) : [];
	if (oauthApps.length === 0) return null;
	const oauthApp = oauthApps[0];
	const clientId = (token.client_id as string) || oauthApp.clientId;
	let clientSecret: string;
	try { clientSecret = resolveClientSecret(oauthApp.clientSecret); } catch { return null; }
	const authMethod = (token.authorization_method as string) || 'BODY';
	const body: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken };
	const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
	if (authMethod === 'HEADER') {
		headers['Authorization'] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
	} else {
		body.client_id = clientId;
		body.client_secret = clientSecret;
	}
	try {
		const response = await fetch(tokenUrl, { method: 'POST', headers, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20000) });
		if (!response.ok) return null;
		const data = (await response.json()) as Record<string, unknown>;
		return { ...token, access_token: data.access_token ?? token.access_token, token_type: data.token_type ?? token.token_type, expires_in: data.expires_in ?? token.expires_in, scope: data.scope ?? token.scope, refresh_token: data.refresh_token ?? token.refresh_token, claimed_at: Math.floor(Date.now() / 1000) };
	} catch { return null; }
}

export interface AppConnectionSummary {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	createdAt: Date;
	pieceDisplayName?: string | null;
	pieceLogoUrl?: string | null;
}

export interface DecryptedAppConnection {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	value: Record<string, unknown>;
}

export function normalizePieceName(value: string | null | undefined): string {
	if (!value) return '';
	const trimmed = value.trim();
	return trimmed.startsWith('@activepieces/piece-')
		? trimmed.slice('@activepieces/piece-'.length)
		: trimmed;
}

function expandPieceNameCandidates(pieceName?: string | null): string[] {
	const normalized = normalizePieceName(pieceName);
	if (!normalized) return [];
	return Array.from(
		new Set([normalized, `@activepieces/piece-${normalized}`]),
	);
}

async function loadPieceMetadataMap(pieceNames: string[]): Promise<Map<string, { displayName: string | null; logoUrl: string | null }>> {
	const normalizedNames = Array.from(
		new Set(pieceNames.map((value) => normalizePieceName(value)).filter(Boolean)),
	);
	if (!db || normalizedNames.length === 0) return new Map();

	const rows = await db
		.selectDistinctOn([pieceMetadata.name], {
			name: pieceMetadata.name,
			displayName: pieceMetadata.displayName,
			logoUrl: pieceMetadata.logoUrl,
		})
		.from(pieceMetadata)
		.orderBy(pieceMetadata.name, pieceMetadata.updatedAt);

	const lookup = new Map<string, { displayName: string | null; logoUrl: string | null }>();
	for (const row of rows) {
		if (!normalizedNames.includes(row.name)) continue;
		lookup.set(row.name, {
			displayName: row.displayName ?? null,
			logoUrl: row.logoUrl ?? null,
		});
	}
	return lookup;
}

export async function listAppConnections(options?: {
	pieceName?: string | null;
	providerId?: string | null;
}): Promise<AppConnectionSummary[]> {
	if (!db) return [];

	const pieceNameFilter = options?.pieceName || options?.providerId || null;
	const candidates = expandPieceNameCandidates(pieceNameFilter);

	const rows = await db
		.select({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt,
		})
		.from(appConnections)
		.where(
			candidates.length > 0
				? inArray(appConnections.pieceName, candidates)
				: undefined,
		)
		.orderBy(desc(appConnections.createdAt));

	const pieceMap = await loadPieceMetadataMap(rows.map((row) => row.pieceName));
	return rows.map((row) => {
		const meta = pieceMap.get(normalizePieceName(row.pieceName));
		return {
			...row,
			pieceDisplayName: meta?.displayName ?? null,
			pieceLogoUrl: meta?.logoUrl ?? null,
		};
	});
}

export async function getDecryptedAppConnection(
	externalId: string,
): Promise<DecryptedAppConnection | null> {
	if (!db) return null;

	const [connection] = await db
		.select()
		.from(appConnections)
		.where(eq(appConnections.externalId, externalId))
		.limit(1);

	if (!connection) return null;

	let decryptedValue = decryptObject(connection.value as EncryptedObject);

	// Auto-refresh expired OAuth2 tokens
	const isOAuth2 = connection.type === 'OAUTH2' || connection.type === 'PLATFORM_OAUTH2' || connection.type === 'CLOUD_OAUTH2';
	if (isOAuth2 && typeof decryptedValue === 'object' && decryptedValue !== null) {
		const tokenObj = decryptedValue as Record<string, unknown>;
		if (isTokenExpired(tokenObj)) {
			console.log(`[OAuth2 Refresh] Token expired for ${connection.pieceName}, refreshing...`);
			const refreshed = await refreshOAuth2Token(tokenObj, connection.pieceName);
			if (refreshed && db) {
				const encrypted = encryptObject(refreshed);
				await db.update(appConnections).set({ value: encrypted, updatedAt: new Date() }).where(eq(appConnections.id, connection.id));
				decryptedValue = refreshed;
				console.log(`[OAuth2 Refresh] Token refreshed for ${connection.pieceName}`);
			}
		}
	}

	return {
		id: connection.id,
		externalId: connection.externalId,
		pieceName: connection.pieceName,
		displayName: connection.displayName,
		type: connection.type,
		status: connection.status,
		value: decryptedValue,
	};
}
