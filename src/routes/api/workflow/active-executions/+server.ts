import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * GET /api/workflow/active-executions
 *
 * Returns executions with status "pending" or "running" for the authenticated user.
 * Security: Session auth (cookie or Bearer token).
 */
export const GET: RequestHandler = async ({ request, cookies }) => {
	try {
		const session = await getSession(request, cookies);
		if (!session) {
			return error(401, 'Unauthorized');
		}

		if (!db) {
			return error(503, 'Database not configured');
		}

		const activeStatuses = ['pending', 'running'] as const;

		const executions = await db
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				status: workflowExecutions.status,
				phase: workflowExecutions.phase
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(
				and(
					eq(workflowExecutions.userId, session.user.id),
					inArray(workflowExecutions.status, [...activeStatuses])
				)
			)
			.limit(50);

		const result = executions.map((e) => ({
			id: e.id,
			workflowId: e.workflowId,
			workflowName: e.workflowName,
			status: e.status,
			phase: e.phase,
			approvalEventName: null
		}));

		return json(result);
	} catch (err) {
		console.error('Failed to fetch active executions:', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
