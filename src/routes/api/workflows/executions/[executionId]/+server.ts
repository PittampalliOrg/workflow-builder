import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { ownsBenchmarkOrEvalRun } from '$lib/server/lifecycle/ownership';
import { isResourceInScope } from '$lib/server/workflows/project-scope';

/**
 * GET /api/workflows/executions/[executionId]
 *
 * Returns the full execution row by id, including the input/output JSONB.
 * Used by callers (e.g. the runs panel) that have polled a summary list and
 * now need full detail for a specific row without re-pulling the whole list.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { executionId } = params;

	if (!db) return error(503, 'Database not configured');

	const [row] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!row) return error(404, 'Execution not found');

	if (locals.session?.userId && !isResourceInScope(row, locals.session)) {
		return error(404, 'Execution not found');
	}

	// Surface coordinator ownership so the run UI can hide the generic Stop for a
	// benchmark/eval instance (which is driven by its run coordinator) and link to
	// the owning run's cancel surface instead.
	const owner = await ownsBenchmarkOrEvalRun(executionId);

	return json({ ...row, owner });
};
