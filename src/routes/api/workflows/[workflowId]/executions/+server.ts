import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * GET /api/workflows/[workflowId]/executions
 *
 * Lists executions for a specific workflow from the database.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const { workflowId } = params;
	const limit = parseInt(url.searchParams.get('limit') || '20');

	if (!db) return json([]);

	try {
		const executions = await db
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				status: workflowExecutions.status,
				daprInstanceId: workflowExecutions.daprInstanceId,
				input: workflowExecutions.input,
				output: workflowExecutions.output,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, workflowId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);

		return json(executions);
	} catch (err) {
		console.error(`[Executions API] Error listing executions for ${workflowId}:`, err);
		return json([]);
	}
};
