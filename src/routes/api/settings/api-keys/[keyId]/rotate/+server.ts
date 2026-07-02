import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * POST /api/settings/api-keys/[keyId]/rotate
 *
 * Rotate an API key: generate a fresh secret in place (same `id`, same
 * `name`), invalidate the old one. The plaintext is returned once.
 *
 * Callers using the old secret will start getting 401 immediately — the
 * old key hash is overwritten. Keeping the row's id stable avoids dangling
 * references from any external systems that persist the key id.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { keyId } = params;

	const rotated = await getApplicationAdapters().workflowData.rotateUserApiKey({
		userId: locals.session.userId,
		keyId,
	});

	if (!rotated) return error(404, { message: 'API key not found' });
	return json(rotated);
};
