import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import {
	loadExecutionReadModel,
	serializeExecutionReadModel
} from '$lib/server/execution-read-model';
import { isResourceInScope } from '$lib/server/workflows/project-scope';

/**
 * GET /api/workflows/executions/[executionId]/status
 *
 * Returns the execution read model using the same shaping logic as the
 * realtime stream endpoint. This keeps the legacy status route aligned with
 * the new SSE-backed run page.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const { executionId } = params;
	const includeAgentEvents = url.searchParams.get('includeAgentEvents') === 'true';

	// CMA scoping: pre-check the execution's project_id against the caller's
	// active workspace before loading the read model. Cross-workspace
	// mismatches return 404 so existence isn't leaked.
	if (db && locals.session?.userId) {
		const [row] = await db
			.select({
				projectId: workflowExecutions.projectId,
				userId: workflowExecutions.userId
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (!isResourceInScope(row, locals.session)) {
			return error(404, 'Execution not found');
		}
	}

	try {
		const model = await loadExecutionReadModel(executionId, {
			refreshRuntime: true,
			includeAgentEvents
		});

		if (model) {
			return json(
				serializeExecutionReadModel(model, {
					compact: false,
					includeAgentEvents
				})
			);
		}

		return error(404, 'Execution not found');
	} catch (readModelError) {
		console.error('[ExecutionStatus] execution read-model load failed:', readModelError);
		return error(
			503,
			readModelError instanceof Error
				? readModelError.message
				: 'Execution read-model migration is required'
		);
	}
};
