import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { appConnections } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { encryptObject } from '$lib/server/security/encryption';
import { AppConnectionStatus } from '$lib/server/types/app-connection';
import { generateId } from '$lib/server/utils/id';

/**
 * GET /api/app-connections
 *
 * List all app connections (without encrypted values).
 */
export const GET: RequestHandler = async () => {
	if (!db) return json([]);

	const result = await db
		.select({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt
		})
		.from(appConnections)
		.orderBy(desc(appConnections.createdAt));

	return json(result);
};

/**
 * POST /api/app-connections
 *
 * Create a new app connection. Currently supports SECRET_TEXT type.
 * Encrypts the value before storing.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!db) return error(503, 'Database not configured');

	const body = await request.json();
	const { pieceName, displayName, type, value } = body;

	if (!pieceName || !displayName || !type) {
		return error(400, { message: 'pieceName, displayName, and type are required' });
	}

	if (type === 'SECRET_TEXT' && !value) {
		return error(400, { message: 'value is required for SECRET_TEXT connections' });
	}

	// Encrypt the connection value
	const encryptedValue = encryptObject(
		typeof value === 'string' ? { secret_text: value } : value
	);

	const id = generateId();
	const externalId = `conn_${id}`;

	const [connection] = await db
		.insert(appConnections)
		.values({
			id,
			externalId,
			pieceName,
			displayName,
			type,
			status: AppConnectionStatus.ACTIVE,
			value: encryptedValue,
			pieceVersion: '0.0.0',
			projectIds: []
		})
		.returning({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt
		});

	return json(connection, { status: 201 });
};
