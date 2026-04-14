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

async function validateConnectionBinding(pieceName: string | null, externalId: unknown) {
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
 * POST /api/mcp-connections/[id] (status update)
 * Toggle enable/disable status.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const { id } = params;
	const body = await request.json();
	const { status } = body;

	if (status !== undefined && !['ENABLED', 'DISABLED'].includes(status)) {
		return error(400, 'status must be ENABLED or DISABLED');
	}

	const [existing] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, id)).limit(1);
	if (!existing) return error(404, 'Connection not found');

	const updates: Partial<typeof mcpConnections.$inferInsert> = {
		updatedBy: locals.session.userId,
		updatedAt: new Date()
	};

	if (status !== undefined) updates.status = status;
	if ('connectionExternalId' in body) {
		if (existing.sourceType !== 'nimble_piece') {
			return error(400, 'connectionExternalId can only be set for piece MCP connections');
		}
		updates.connectionExternalId = await validateConnectionBinding(
			existing.pieceName,
			body.connectionExternalId
		);
	}

	const [conn] = await db
		.update(mcpConnections)
		.set(updates)
		.where(eq(mcpConnections.id, id))
		.returning();

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
