import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { projectMembers } from '$lib/server/db/schema';
import type { ProjectRole } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import {
	rotateMcpServerToken,
	syncHostedWorkflowMcpConnection
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
 * POST /api/v1/projects/[projectId]/mcp-server/rotate
 *
 * Rotate the MCP server authentication token.
 * Requires ADMIN or EDITOR role on the project.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const { projectId } = params;
	const role = await getUserProjectRole(locals.session.userId, projectId);
	if (!(role && canWriteMcp(role))) return error(403, 'Forbidden');

	const updated = await rotateMcpServerToken({ projectId });
	await syncHostedWorkflowMcpConnection({
		projectId,
		status: updated.status,
		actorUserId: locals.session.userId,
		request
	});
	return json(updated);
};
