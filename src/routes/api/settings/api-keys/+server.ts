import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/settings/api-keys
 *
 * List all API keys for the current user (without key hashes).
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	return json(await getApplicationAdapters().workflowData.listUserApiKeys(locals.session.userId));
};

/**
 * POST /api/settings/api-keys
 *
 * Create a new API key. Returns the plaintext key once — it cannot be retrieved again.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = await request.json();
	const { name } = body;

	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return error(400, { message: 'name is required' });
	}

	const created = await getApplicationAdapters().workflowData.createUserApiKey({
		userId: locals.session.userId,
		name,
	});

	return json(created, { status: 201 });
};
