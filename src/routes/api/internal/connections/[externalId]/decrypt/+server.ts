import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { db } from '$lib/server/db';
import { appConnections } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decryptObject, type EncryptedObject } from '$lib/server/security/encryption';

/**
 * GET /api/internal/connections/[externalId]/decrypt
 *
 * Decrypts a connection's value by externalId.
 *
 * Called by function-router to retrieve decrypted credentials at execution time.
 * For OAuth2 connections, a future enhancement will auto-refresh expired tokens.
 *
 * Security: Validated via X-Internal-Token header.
 * In production, Kubernetes network policy restricts access to function-router only.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	if (!db) {
		return error(503, 'Database not configured');
	}

	const { externalId } = params;

	const [connection] = await db
		.select()
		.from(appConnections)
		.where(eq(appConnections.externalId, externalId))
		.limit(1);

	if (!connection) {
		return error(404, 'Connection not found');
	}

	// Decrypt the connection value
	const decryptedValue = decryptObject(connection.value as EncryptedObject);

	return json({
		id: connection.id,
		externalId: connection.externalId,
		type: connection.type,
		pieceName: connection.pieceName,
		value: decryptedValue
	});
};
