import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { users, platformOauthApps, pieceMetadata } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals, url }) => {
	const baseUrl = `${url.protocol}//${url.host}`;

	if (!locals.session?.userId || !db) {
		return { profile: null, baseUrl, oauthApps: [] };
	}

	const [user] = await db
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			image: users.image,
			platformId: users.platformId,
			platformRole: users.platformRole
		})
		.from(users)
		.where(eq(users.id, locals.session.userId))
		.limit(1);

	const platformId = user?.platformId ?? locals.session.platformId;

	// Load configured OAuth apps for the caller's platform.
	const oauthApps =
		db && platformId
			? await db
					.select({
						id: platformOauthApps.id,
						pieceName: platformOauthApps.pieceName,
						clientId: platformOauthApps.clientId,
						createdAt: platformOauthApps.createdAt,
						updatedAt: platformOauthApps.updatedAt
					})
					.from(platformOauthApps)
					.where(eq(platformOauthApps.platformId, platformId))
					.orderBy(platformOauthApps.pieceName)
			: [];

	// Load piece metadata for logos — get distinct OAuth2 pieces
	const oauthPieces = db
		? await db
				.selectDistinctOn([pieceMetadata.name], {
					name: pieceMetadata.name,
					displayName: pieceMetadata.displayName,
					logoUrl: pieceMetadata.logoUrl
				})
				.from(pieceMetadata)
				// Only bundled pieces are usable, so only they can have a platform OAuth
				// app configured — exclude available-only catalog rows.
				.where(sql`${pieceMetadata.auth}->>'type' = 'OAUTH2' AND ${pieceMetadata.availableOnly} = false`)
				.orderBy(pieceMetadata.name, pieceMetadata.displayName)
		: [];

	const configuredByPiece = new Map(
		oauthApps.map((app) => [normalizePieceName(app.pieceName), app])
	);
	const oauthPieceNames = new Set(oauthPieces.map((piece) => piece.name));

	const enrichedOauthApps = [
		...oauthPieces.map((piece) => {
			const app = configuredByPiece.get(piece.name);
			return {
				id: app?.id ?? null,
				pieceName: `@activepieces/piece-${piece.name}`,
				clientId: app?.clientId ?? '',
				displayName: piece.displayName || formatPieceName(piece.name),
				logoUrl: piece.logoUrl || null,
				configured: Boolean(app),
				createdAt: app?.createdAt ?? null,
				updatedAt: app?.updatedAt ?? null
			};
		}),
		...oauthApps
			.filter((app) => !oauthPieceNames.has(normalizePieceName(app.pieceName)))
			.map((app) => ({
				id: app.id,
				pieceName: app.pieceName,
				clientId: app.clientId,
				displayName: formatPieceName(app.pieceName),
				logoUrl: null,
				configured: true,
				createdAt: app.createdAt,
				updatedAt: app.updatedAt
			}))
	].sort((a, b) => a.displayName.localeCompare(b.displayName));

	return {
		profile: user || null,
		baseUrl,
		oauthApps: enrichedOauthApps
	};
};

function normalizePieceName(pieceName: string): string {
	return pieceName.startsWith('@activepieces/piece-')
		? pieceName.slice('@activepieces/piece-'.length)
		: pieceName;
}

function formatPieceName(pieceName: string): string {
	return normalizePieceName(pieceName)
		.split('-')
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
};
