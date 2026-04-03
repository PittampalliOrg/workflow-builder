import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * DELETE /api/settings/api-keys/[keyId]
 *
 * Delete an API key by ID (only if it belongs to the current user).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { keyId } = params;

	const deleted = await db
		.delete(apiKeys)
		.where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, locals.session?.userId)))
		.returning({ id: apiKeys.id });

	if (deleted.length === 0) {
		return error(404, { message: 'API key not found' });
	}

	return json({ success: true });
};
