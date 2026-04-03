import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { projectMembers } from '$lib/server/db/schema';
import type { ProjectRole } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import {
	getPopulatedMcpServerByProjectId,
	syncHostedWorkflowMcpConnection,
	updateMcpServerStatus
} from '$lib/server/db/mcp';

function canWriteMcp(role: ProjectRole): boolean {
	return role === 'ADMIN' || role === 'EDITOR';
}

async function getUserProjectRole(
	userId: string,
	projectId: string
): Promise<ProjectRole | null> {
	const result = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)))
		.limit(1);
	return result.length > 0 ? result[0].role : null;
}

/**
 * GET /api/v1/projects/[projectId]/mcp-server
 *
 * Returns the populated MCP server config (token, status, MCP-triggered workflows).
 * Also syncs the hosted workflow MCP connection row.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { projectId } = params;
	const role = await getUserProjectRole(locals.session.userId, projectId);
	if (!role) return error(403, 'Forbidden');

	const mcpServer = await getPopulatedMcpServerByProjectId(projectId);
	await syncHostedWorkflowMcpConnection({
		projectId,
		status: mcpServer.status,
		actorUserId: locals.session.userId,
		request
	});
	return json(mcpServer);
};

/**
 * POST /api/v1/projects/[projectId]/mcp-server
 *
 * Update MCP server status (ENABLED / DISABLED).
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { projectId } = params;
	const role = await getUserProjectRole(locals.session.userId, projectId);
	if (!(role && canWriteMcp(role))) return error(403, 'Forbidden');

	const body = (await request.json().catch(() => null)) as {
		status?: 'ENABLED' | 'DISABLED';
	} | null;

	if (!body?.status || (body.status !== 'ENABLED' && body.status !== 'DISABLED')) {
		return error(400, 'Invalid status');
	}

	const updated = await updateMcpServerStatus({ projectId, status: body.status });
	await syncHostedWorkflowMcpConnection({
		projectId,
		status: updated.status,
		actorUserId: locals.session.userId,
		request
	});
	return json(updated);
};
