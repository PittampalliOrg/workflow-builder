import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	loadExecutionReadModel,
	serializeExecutionReadModel
} from '$lib/server/execution-read-model';

/**
 * GET /api/workflows/executions/[executionId]/status
 *
 * Returns the execution read model using the same shaping logic as the
 * realtime stream endpoint. This keeps the legacy status route aligned with
 * the new SSE-backed run page.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	try {
		const model = await loadExecutionReadModel(executionId, {
			refreshRuntime: true,
			includeAgentEvents: false
		});

		if (model) {
			return json(
				serializeExecutionReadModel(model, {
					compact: false,
					includeAgentEvents: false
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
