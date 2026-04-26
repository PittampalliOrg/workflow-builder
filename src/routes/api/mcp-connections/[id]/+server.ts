import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { mcpConnections } from '$lib/server/db/schema';
import {
	requireSessionProjectId,
	validateMcpCredentialBinding
} from '$lib/server/mcp-connections';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const projectId = requireSessionProjectId(locals);
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const status = body.status;

	if (status !== undefined && status !== 'ENABLED' && status !== 'DISABLED') {
		return error(400, 'status must be ENABLED or DISABLED');
	}

	const [existing] = await db
		.select()
		.from(mcpConnections)
		.where(and(eq(mcpConnections.id, params.id), eq(mcpConnections.projectId, projectId)))
		.limit(1);
	if (!existing) return error(404, 'Connection not found');

	const updates: Partial<typeof mcpConnections.$inferInsert> = {
		updatedBy: userId,
		updatedAt: new Date()
	};

	if (status !== undefined) updates.status = status;
	if ('connectionExternalId' in body) {
		if (existing.sourceType !== 'nimble_piece') {
			return error(400, 'connectionExternalId can only be set for piece MCP connections');
		}
		updates.connectionExternalId = await validateMcpCredentialBinding(
			db,
			projectId,
			existing.pieceName,
			body.connectionExternalId
		);
	}

	const [conn] = await db
		.update(mcpConnections)
		.set(updates)
		.where(and(eq(mcpConnections.id, params.id), eq(mcpConnections.projectId, projectId)))
		.returning();

	return json(conn);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const projectId = requireSessionProjectId(locals);
	if (!db) return error(500, 'Database not available');

	const [existing] = await db
		.select()
		.from(mcpConnections)
		.where(and(eq(mcpConnections.id, params.id), eq(mcpConnections.projectId, projectId)))
		.limit(1);
	if (!existing) return error(404, 'Connection not found');
	if (existing.sourceType === 'hosted_workflow') {
		return error(400, 'Cannot delete hosted workflow connections');
	}

	await db
		.delete(mcpConnections)
		.where(and(eq(mcpConnections.id, params.id), eq(mcpConnections.projectId, projectId)));

	return json({ success: true });
};
