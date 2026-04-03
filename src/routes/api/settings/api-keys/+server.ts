import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { generateId } from '$lib/server/utils/id';
import { createHash, randomBytes } from 'node:crypto';

/**
 * GET /api/settings/api-keys
 *
 * List all API keys for the current user (without key hashes).
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!db) return json([]);
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const result = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			keyPrefix: apiKeys.keyPrefix,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, locals.session?.userId))
		.orderBy(desc(apiKeys.createdAt));

	return json(result);
};

/**
 * POST /api/settings/api-keys
 *
 * Create a new API key. Returns the plaintext key once — it cannot be retrieved again.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const body = await request.json();
	const { name } = body;

	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return error(400, { message: 'name is required' });
	}

	// Generate a random API key: wf_<32 random hex chars>
	const rawBytes = randomBytes(32);
	const plaintextKey = `wf_${rawBytes.toString('hex')}`;
	const keyPrefix = plaintextKey.slice(0, 10) + '...';
	const keyHash = createHash('sha256').update(plaintextKey).digest('hex');

	const id = generateId();

	const [created] = await db
		.insert(apiKeys)
		.values({
			id,
			userId: locals.session?.userId,
			name: name.trim(),
			keyHash,
			keyPrefix
		})
		.returning({
			id: apiKeys.id,
			name: apiKeys.name,
			keyPrefix: apiKeys.keyPrefix,
			createdAt: apiKeys.createdAt
		});

	return json({ ...created, key: plaintextKey }, { status: 201 });
};
