import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

const SUMMARY_COLUMNS = {
	id: workflowExecutions.id,
	workflowId: workflowExecutions.workflowId,
	status: workflowExecutions.status,
	daprInstanceId: workflowExecutions.daprInstanceId,
	startedAt: workflowExecutions.startedAt,
	completedAt: workflowExecutions.completedAt,
	duration: workflowExecutions.duration
};

const FULL_COLUMNS = {
	...SUMMARY_COLUMNS,
	input: workflowExecutions.input,
	output: workflowExecutions.output
};

/**
 * GET /api/workflows/[workflowId]/executions
 *
 * Lists executions for a specific workflow from the database.
 *
 * Query params:
 *   include=summary (default) — drops input/output JSONB. Use for list views/polling.
 *   include=full — returns input/output. Use only when callers actually render them.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const { workflowId } = params;
	const limit = parseInt(url.searchParams.get('limit') || '20');
	const include = url.searchParams.get('include') === 'full' ? 'full' : 'summary';

	if (!db) return json([]);

	try {
		const executions = await db
			.select(include === 'full' ? FULL_COLUMNS : SUMMARY_COLUMNS)
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
