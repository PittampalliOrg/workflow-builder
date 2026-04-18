import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

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
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { keyId } = params;

	const [existing] = await db
		.select({ id: apiKeys.id })
		.from(apiKeys)
		.where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, locals.session.userId)))
		.limit(1);
	if (!existing) return error(404, { message: 'API key not found' });

	const rawBytes = randomBytes(32);
	const plaintextKey = `wfb_${rawBytes.toString('hex')}`;
	const keyPrefix = plaintextKey.slice(0, 11) + '...';
	const keyHash = createHash('sha256').update(plaintextKey).digest('hex');

	const [rotated] = await db
		.update(apiKeys)
		.set({
			keyHash,
			keyPrefix,
			lastUsedAt: null,
		})
		.where(eq(apiKeys.id, keyId))
		.returning({
			id: apiKeys.id,
			name: apiKeys.name,
			keyPrefix: apiKeys.keyPrefix,
			createdAt: apiKeys.createdAt,
		});

	return json({ ...rotated, key: plaintextKey });
};
