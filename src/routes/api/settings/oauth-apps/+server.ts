import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { platforms, platformOauthApps } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encryptString } from '$lib/server/security/encryption';
import { generateId } from '$lib/server/utils/id';

async function resolvePlatformId(sessionPlatformId?: string | null): Promise<string> {
	if (!db) throw new Error('Database not available');
	if (sessionPlatformId) return sessionPlatformId;

	const [existing] = await db
		.select({ id: platforms.id })
		.from(platforms)
		.orderBy(platforms.createdAt)
		.limit(1);
	if (existing?.id) return existing.id;

	const [created] = await db
		.insert(platforms)
		.values({
			id: 'default-platform',
			name: 'Default Platform',
			createdAt: new Date(),
			updatedAt: new Date()
		})
		.returning({ id: platforms.id });
	return created.id;
}

/**
 * POST /api/settings/oauth-apps
 * Create or update an OAuth app configuration.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const { id, pieceName, clientId, clientSecret } = body;

	if (typeof pieceName !== 'string' || !pieceName.trim() || typeof clientId !== 'string' || !clientId.trim()) {
		return error(400, 'pieceName and clientId are required');
	}

	if (id) {
		const updateData: Record<string, unknown> = {
			clientId: clientId.trim(),
			updatedAt: new Date()
		};
		if (typeof clientSecret === 'string' && clientSecret.trim()) {
			updateData.clientSecret = encryptString(clientSecret.trim());
		}

		await db
			.update(platformOauthApps)
			.set(updateData)
			.where(eq(platformOauthApps.id, String(id)));

		return json({ success: true });
	}

	if (typeof clientSecret !== 'string' || !clientSecret.trim()) {
		return error(400, 'clientSecret is required when creating an OAuth app');
	}

	const platformId = await resolvePlatformId(locals.session.platformId);
	const now = new Date();
	const [app] = await db
		.insert(platformOauthApps)
		.values({
			id: generateId(),
			platformId,
			pieceName: pieceName.trim(),
			clientId: clientId.trim(),
			clientSecret: encryptString(clientSecret.trim()),
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: [platformOauthApps.platformId, platformOauthApps.pieceName],
			set: {
				clientId: clientId.trim(),
				clientSecret: encryptString(clientSecret.trim()),
				updatedAt: now
			}
		})
		.returning();

	return json({ success: true, app }, { status: 201 });
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
