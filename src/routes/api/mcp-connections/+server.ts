import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { mcpConnections } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import {
	humanizePieceName,
	normalizePieceName,
	pieceMcpRegistryRef,
	pieceMcpServerUrl,
	requireSessionProjectId,
	validateMcpCredentialBinding
} from '$lib/server/mcp-connections';

/**
 * GET /api/mcp-connections
 * List all MCP connections.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const projectId = requireSessionProjectId(locals);
	if (!db) return json([]);

	const connections = await db
		.select()
		.from(mcpConnections)
		.where(eq(mcpConnections.projectId, projectId))
		.orderBy(mcpConnections.displayName);

	return json(connections);
};

/**
 * POST /api/mcp-connections
 * Create a new MCP connection (custom URL type).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const projectId = requireSessionProjectId(locals);
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const body = await request.json();
	const sourceType = typeof body.sourceType === 'string' ? body.sourceType : 'custom_url';
	const connectionExternalId = body.connectionExternalId;

	if (!['custom_url', 'nimble_piece'].includes(sourceType)) {
		return error(400, 'sourceType must be custom_url or nimble_piece');
	}

	const id = crypto.randomUUID().replace(/-/g, '').slice(0, 21);
	const now = new Date();

	if (sourceType === 'nimble_piece') {
		const pieceName = normalizePieceName(body.pieceName);
		if (!pieceName) return error(400, 'pieceName is required for piece MCP connections');
		const displayName =
			(typeof body.displayName === 'string' && body.displayName.trim()) || humanizePieceName(pieceName);
		const credentialBinding = await validateMcpCredentialBinding(
			db,
			projectId,
			pieceName,
			connectionExternalId
		);
		const metadata =
			body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
				? { transport: 'streamable_http', ...body.metadata }
				: { transport: 'streamable_http' };

		const existing = await db
			.select()
			.from(mcpConnections)
			.where(
				and(
					eq(mcpConnections.projectId, projectId),
					eq(mcpConnections.sourceType, 'nimble_piece'),
					eq(mcpConnections.pieceName, pieceName)
				)
			)
			.limit(1);

		if (existing.length > 0) {
			const [conn] = await db
				.update(mcpConnections)
				.set({
					connectionExternalId: credentialBinding,
					displayName,
					registryRef: pieceMcpRegistryRef(pieceName),
					serverUrl: pieceMcpServerUrl(pieceName),
					status: 'ENABLED',
					metadata,
					updatedBy: userId,
					updatedAt: now
				})
				.where(eq(mcpConnections.id, existing[0].id))
				.returning();
			return json(conn);
		}

		const [conn] = await db
			.insert(mcpConnections)
			.values({
				id,
				projectId,
				sourceType: 'nimble_piece',
				pieceName,
				connectionExternalId: credentialBinding,
				displayName,
				registryRef: pieceMcpRegistryRef(pieceName),
				serverUrl: pieceMcpServerUrl(pieceName),
				status: 'ENABLED',
				metadata,
				createdBy: userId,
				updatedBy: userId
			})
			.returning();

		return json(conn, { status: 201 });
	}

	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
	const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : '';
	if (!displayName || !serverUrl) {
		return error(400, 'displayName and serverUrl are required');
	}

	const [conn] = await db
		.insert(mcpConnections)
		.values({
			id,
			projectId,
			sourceType: 'custom_url',
			pieceName: null,
			connectionExternalId: null,
			displayName,
			serverUrl,
			status: 'ENABLED',
			createdBy: userId,
			updatedBy: userId
		})
		.returning();

	return json(conn);
};
