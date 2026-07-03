import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { getAppUrl } from '$lib/server/app-url';
import { enablePiece, isValidPieceSlug } from '$lib/server/pieces/piece-images';

/**
 * Admin-gated: enable an Activepieces piece on THIS cluster via its per-piece runtime
 * image (docs/per-piece-runtime-images.md). Instant when `ap-piece-<name>:<version>`
 * already exists in GHCR; otherwise records `building` + triggers a hub build whose
 * callback (POST /api/internal/pieces/<name>/image-registration) flips it runnable.
 *
 * Replaces the old "available-only pieces need a bundle + image rebuild, not a DB
 * toggle" limitation on the admin pieces page.
 */
async function requireAdmin(userId: string | undefined | null): Promise<void> {
	if (!userId) throw error(403, 'Admin access required');
	try {
		const isAdmin = await getApplicationAdapters().workflowData.isPlatformAdmin(userId);
		if (!isAdmin) throw error(403, 'Admin access required');
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(403, 'Admin access required');
	}
}

export const POST: RequestHandler = async ({ params, locals, request, url }) => {
	await requireAdmin(locals.session?.userId);
	const pieceName = decodeURIComponent(params.pieceName);
	if (!isValidPieceSlug(pieceName)) return error(400, 'invalid piece name');

	try {
		const callbackUrl = await getAppUrl(url, request);
		const result = await enablePiece(pieceName, { callbackUrl });
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'enable failed';
		// "not in the catalog" → 404; everything else (db, trigger) → 500.
		if (/not in the catalog/.test(msg)) return error(404, msg);
		return error(500, msg);
	}
};
