import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { mcpConnections } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

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
	const { displayName, serverUrl, sourceType } = body;

	if (!displayName || !serverUrl) {
		return error(400, 'displayName and serverUrl are required');
	}

	const id = crypto.randomUUID().replace(/-/g, '').slice(0, 21);

	const [conn] = await db
		.insert(mcpConnections)
		.values({
			id,
			projectId: 'default',
			sourceType: sourceType || 'custom_url',
			displayName,
			serverUrl,
			status: 'ENABLED',
			createdBy: locals.session.userId,
			updatedBy: locals.session.userId
		})
		.returning();

	return json(conn);
};
