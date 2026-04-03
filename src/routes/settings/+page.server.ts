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

	// Load all configured OAuth apps from the database
	const oauthApps = db
		? await db
				.select({
					id: platformOauthApps.id,
					pieceName: platformOauthApps.pieceName,
					clientId: platformOauthApps.clientId,
					createdAt: platformOauthApps.createdAt,
					updatedAt: platformOauthApps.updatedAt
				})
				.from(platformOauthApps)
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
				.where(sql`${pieceMetadata.auth}->>'type' = 'OAUTH2'`)
				.orderBy(pieceMetadata.name, pieceMetadata.displayName)
		: [];

	// Build a lookup map: pieceName → { displayName, logoUrl }
	const pieceMap = new Map(oauthPieces.map(p => [
		`@activepieces/piece-${p.name}`,
		{ displayName: p.displayName, logoUrl: p.logoUrl }
	]));

	// Enrich oauth apps with piece display info
	const enrichedOauthApps = oauthApps.map(app => ({
		...app,
		displayName: pieceMap.get(app.pieceName)?.displayName || formatPieceName(app.pieceName),
		logoUrl: pieceMap.get(app.pieceName)?.logoUrl || null
	}));

	return {
		profile: user || null,
		baseUrl,
		oauthApps: enrichedOauthApps
	};
};

function formatPieceName(pieceName: string): string {
	return pieceName
		.replace('@activepieces/piece-', '')
		.split('-')
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
};
