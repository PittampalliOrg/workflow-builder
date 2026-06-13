import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { pieceMetadata } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';

/**
 * GET /api/pieces?auth=true
 * Returns all pieces that require auth (for connection creation combobox).
 */
export const GET: RequestHandler = async ({ url }) => {
	if (!db) return json([]);

	const authOnly = url.searchParams.get('auth') === 'true';

	// Only bundled/runnable pieces are connectable — exclude available-only catalog
	// rows so they never appear in the connection-creation combobox.
	const whereClause = authOnly
		? sql`${pieceMetadata.availableOnly} = false AND ${pieceMetadata.auth} IS NOT NULL AND ${pieceMetadata.auth}->>'type' != 'NONE'`
		: sql`${pieceMetadata.availableOnly} = false`;

	const pieces = await db
		.selectDistinctOn([pieceMetadata.name], {
			name: pieceMetadata.name,
			displayName: pieceMetadata.displayName,
			logoUrl: pieceMetadata.logoUrl,
			authType: sql<string>`${pieceMetadata.auth}->>'type'`
		})
		.from(pieceMetadata)
		.where(whereClause)
		.orderBy(pieceMetadata.name, pieceMetadata.displayName);

	return json(
		pieces.map((p) => ({
			name: `@activepieces/piece-${p.name}`,
			displayName: p.displayName,
			logoUrl: p.logoUrl,
			authType: p.authType
		}))
	);
};
