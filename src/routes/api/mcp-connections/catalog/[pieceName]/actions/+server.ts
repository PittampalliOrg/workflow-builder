import { error, json } from '@sveltejs/kit';
import { desc, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { pieceMetadata } from '$lib/server/db/schema';
import { pieceActionsFromMetadata } from '$lib/server/mcp-catalog';
import { normalizePieceName, pieceCandidates, requireSessionProjectId } from '$lib/server/mcp-connections';

/**
 * GET /api/mcp-connections/catalog/[pieceName]/actions
 *
 * Per-piece action (tool) list for the agent Tools & Integrations surface.
 * The hub catalog only returns `actionCount`; the grouped per-tool toggle
 * needs the full action list, so it's lazily fetched when a server card
 * expands (keeps the catalog payload lean). Shape matches the piece-detail
 * loader (`pieceActionsFromMetadata`) so both render the same list.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	requireSessionProjectId(locals);
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return json({ pieceName: params.pieceName, actions: [] });

	const pieceName = normalizePieceName(params.pieceName);
	if (!pieceName) return error(404, 'Integration not found');

	const [piece] = await db
		.select({ name: pieceMetadata.name, actions: pieceMetadata.actions })
		.from(pieceMetadata)
		.where(inArray(pieceMetadata.name, pieceCandidates(pieceName)))
		.orderBy(desc(pieceMetadata.updatedAt))
		.limit(1);

	if (!piece) return error(404, 'Integration not found');

	return json({ pieceName, actions: pieceActionsFromMetadata(piece.actions) });
};
