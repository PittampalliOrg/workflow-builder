import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * DELETE /api/settings/api-keys/[keyId]
 *
 * Delete an API key by ID (only if it belongs to the current user).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { keyId } = params;

	const deleted = await getApplicationAdapters().workflowData.deleteUserApiKey({
		userId: locals.session.userId,
		keyId,
	});
	if (!deleted) {
		return error(404, { message: 'API key not found' });
	}

	return json({ success: true });
};
