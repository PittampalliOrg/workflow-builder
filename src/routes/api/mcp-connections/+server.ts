import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { mcpConnections } from '$lib/server/db/schema';
import {
	humanizePieceName,
	normalizePieceName,
	pieceMcpRegistryRef,
	pieceMcpServerUrl,
	requireSessionProjectId,
	validateMcpCredentialBinding
} from '$lib/server/mcp-connections';
import { generateId } from '$lib/server/utils/id';

function metadataFromBody(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return { transport: 'streamable_http', ...(value as Record<string, unknown>) };
	}
	return { transport: 'streamable_http' };
}

function serverKeyFromDisplayName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

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

export const POST: RequestHandler = async ({ request, locals }) => {
	const projectId = requireSessionProjectId(locals);
	const userId = locals.session?.userId;
	if (!userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const sourceType = typeof body.sourceType === 'string' ? body.sourceType : 'custom_url';
	const now = new Date();

	if (!['custom_url', 'nimble_piece'].includes(sourceType)) {
		return error(400, 'sourceType must be custom_url or nimble_piece');
	}

	if (sourceType === 'nimble_piece') {
		const pieceName = normalizePieceName(typeof body.pieceName === 'string' ? body.pieceName : '');
		if (!pieceName) return error(400, 'pieceName is required for piece MCP connections');

		const displayName =
			(typeof body.displayName === 'string' && body.displayName.trim()) ||
			humanizePieceName(pieceName);
		const connectionExternalId = await validateMcpCredentialBinding(
			db,
			projectId,
			pieceName,
			body.connectionExternalId
		);
		const metadata = metadataFromBody(body.metadata);

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
					connectionExternalId,
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
				id: generateId(),
				projectId,
				sourceType: 'nimble_piece',
				pieceName,
				connectionExternalId,
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
	if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
		return error(400, 'serverUrl must be HTTP(S)');
	}

	const [conn] = await db
		.insert(mcpConnections)
		.values({
			id: generateId(),
			projectId,
			sourceType: 'custom_url',
			pieceName: null,
			serverKey: serverKeyFromDisplayName(displayName),
			connectionExternalId: null,
			displayName,
			serverUrl,
			status: 'ENABLED',
			metadata: metadataFromBody(body.metadata),
			createdBy: userId,
			updatedBy: userId
		})
		.returning();

	return json(conn, { status: 201 });
};
