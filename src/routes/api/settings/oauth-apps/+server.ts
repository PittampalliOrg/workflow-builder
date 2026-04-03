import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { platformOauthApps } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * POST /api/settings/oauth-apps
 * Create or update an OAuth app configuration.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const body = await request.json();
	const { id, pieceName, clientId, clientSecret } = body;

	if (!pieceName || !clientId) {
		return error(400, 'pieceName and clientId are required');
	}

	if (id) {
		// Update existing
		const updateData: Record<string, unknown> = {
			clientId,
			updatedAt: new Date()
		};
		if (clientSecret) {
			updateData.clientSecret = JSON.stringify(clientSecret);
		}

		await db
			.update(platformOauthApps)
			.set(updateData)
			.where(eq(platformOauthApps.id, id));

		return json({ success: true });
	} else {
		// Create new — would need platformId, skipping for now
		return error(400, 'Creating new OAuth apps is not supported yet');
	}
};

/**
 * DELETE /api/settings/oauth-apps?id=xxx
 * Remove an OAuth app configuration.
 */
export const DELETE: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const id = url.searchParams.get('id');
	if (!id) return error(400, 'id is required');

	await db.delete(platformOauthApps).where(eq(platformOauthApps.id, id));

	return json({ success: true });
};
