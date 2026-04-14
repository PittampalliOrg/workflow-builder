import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { appConnections, mcpConnections } from '$lib/server/db/schema';
import { AppConnectionStatus } from '$lib/server/types/app-connection';
import { and, eq, inArray } from 'drizzle-orm';

function normalizePieceName(value: string | null | undefined): string {
	return (value || '')
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[_\s]+/g, '-')
		.replace(/-+/g, '-');
}

function pieceCandidates(value: string | null | undefined): string[] {
	const normalized = normalizePieceName(value);
	if (!normalized) return [];
	return [normalized, `@activepieces/piece-${normalized}`];
}

async function validateConnectionBinding(pieceName: string | null | undefined, externalId: unknown) {
	const value = typeof externalId === 'string' ? externalId.trim() : '';
	if (!value) return null;
	const candidates = pieceCandidates(pieceName);
	if (candidates.length === 0) {
		throw error(400, 'connectionExternalId can only be set for a piece MCP connection');
	}
	const [connection] = await db
		.select({ externalId: appConnections.externalId })
		.from(appConnections)
		.where(
			and(
				eq(appConnections.externalId, value),
				eq(appConnections.status, AppConnectionStatus.ACTIVE),
				inArray(appConnections.pieceName, candidates)
			)
		)
		.limit(1);
	if (!connection) {
		throw error(400, 'connectionExternalId must reference an active app connection for the same piece');
	}
	return value;
}

/**
 * GET /api/mcp-connections
 * List all MCP connections.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return json([]);

	const connections = await db
		.select()
		.from(mcpConnections)
		.orderBy(mcpConnections.displayName);

	return json(connections);
};

/**
 * POST /api/mcp-connections
 * Create a new MCP connection (custom URL type).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const body = await request.json();
	const { displayName, serverUrl, sourceType, connectionExternalId } = body;

	if (!displayName || !serverUrl) {
		return error(400, 'displayName and serverUrl are required');
	}

	const id = crypto.randomUUID().replace(/-/g, '').slice(0, 21);
	const credentialBinding = await validateConnectionBinding(body.pieceName, connectionExternalId);

	const [conn] = await db
		.insert(mcpConnections)
		.values({
			id,
			projectId: 'default',
			sourceType: sourceType || 'custom_url',
			pieceName: typeof body.pieceName === 'string' ? normalizePieceName(body.pieceName) : null,
			connectionExternalId: credentialBinding,
			displayName,
			serverUrl,
			status: 'ENABLED',
			createdBy: locals.session.userId,
			updatedBy: locals.session.userId
		})
		.returning();

	return json(conn);
};
