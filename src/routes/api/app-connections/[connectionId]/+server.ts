import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { appConnections } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * PUT /api/app-connections/[connectionId]
 *
 * Update a connection (currently supports renaming via displayName).
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	if (!db) return error(503, 'Database not configured');

	const { connectionId } = params;
	const body = await request.json();
	const { displayName } = body;

	if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
		return error(400, { message: 'displayName is required' });
	}

	const updated = await db
		.update(appConnections)
		.set({ displayName: displayName.trim() })
		.where(eq(appConnections.id, connectionId))
		.returning({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt
		});

	if (updated.length === 0) {
		return error(404, { message: 'Connection not found' });
	}

	return json(updated[0]);
};

/**
 * DELETE /api/app-connections/[connectionId]
 *
 * Delete a connection by ID.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	if (!db) return error(503, 'Database not configured');

	const { connectionId } = params;

	const deleted = await db
		.delete(appConnections)
		.where(eq(appConnections.id, connectionId))
		.returning({ id: appConnections.id });

	if (deleted.length === 0) {
		return error(404, { message: 'Connection not found' });
	}

	return json({ success: true });
};
