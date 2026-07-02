import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * POST /api/settings/oauth-apps
 * Create or update an OAuth app configuration.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const { id, pieceName, clientId, clientSecret } = body;

	if (typeof pieceName !== 'string' || !pieceName.trim() || typeof clientId !== 'string' || !clientId.trim()) {
		return error(400, 'pieceName and clientId are required');
	}

	const updateId = typeof id === 'string' && id.trim() ? id.trim() : null;
	if (!updateId && (typeof clientSecret !== 'string' || !clientSecret.trim())) {
		return error(400, 'clientSecret is required when creating an OAuth app');
	}

	const result = await getApplicationAdapters().workflowData.savePlatformOAuthApp({
		id: updateId,
		sessionPlatformId: locals.session.platformId,
		pieceName,
		clientId,
		clientSecret: typeof clientSecret === 'string' ? clientSecret : null
	});

	return json(result, { status: updateId ? 200 : 201 });
};

/**
 * DELETE /api/settings/oauth-apps?id=xxx
 * Remove an OAuth app configuration.
 */
export const DELETE: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const id = url.searchParams.get('id');
	if (!id) return error(400, 'id is required');

	await getApplicationAdapters().workflowData.deletePlatformOAuthApp(id);

	return json({ success: true });
};
