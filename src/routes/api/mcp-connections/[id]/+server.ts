import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { mcpConnections } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * POST /api/mcp-connections/[id] (status update)
 * Toggle enable/disable status.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const { id } = params;
	const body = await request.json();
	const { status } = body;

	if (!status || !['ENABLED', 'DISABLED'].includes(status)) {
		return error(400, 'status must be ENABLED or DISABLED');
	}

	const [conn] = await db
		.update(mcpConnections)
		.set({ status, updatedBy: locals.session.userId, updatedAt: new Date() })
		.where(eq(mcpConnections.id, id))
		.returning();

	if (!conn) return error(404, 'Connection not found');
	return json(conn);
};

/**
 * DELETE /api/mcp-connections/[id]
 * Remove an MCP connection.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const { id } = params;

	// Don't allow deleting hosted_workflow connections
	const [existing] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, id)).limit(1);
	if (existing?.sourceType === 'hosted_workflow') {
		return error(400, 'Cannot delete hosted workflow connections');
	}

	await db.delete(mcpConnections).where(eq(mcpConnections.id, id));
	return json({ success: true });
};
