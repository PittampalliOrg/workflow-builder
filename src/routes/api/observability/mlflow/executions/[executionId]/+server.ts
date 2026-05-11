import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { resolveMlflowTraceUrlForExecution } from '$lib/server/observability/mlflow';

/**
 * GET /api/observability/mlflow/executions/[executionId]
 *
 * Resolves a workflow execution id to its MLflow trace (by searching the
 * trace experiment for `tag.workflow.execution.id = <id>`) and redirects
 * to the MLflow OSS UI's per-trace page. Mirrors the sessions/[sessionId]
 * pattern — sessions filter by `tag.session.id`; executions filter by
 * `tag.workflow.execution.id`.
 */
export const GET: RequestHandler = async ({ params }) => {
	const executionId = params.executionId?.trim();
	if (!executionId) return error(400, 'Execution id is required');

	const href = await resolveMlflowTraceUrlForExecution(executionId);
	if (!href) {
		return error(
			503,
			'No MLflow trace found for this execution yet. Traces appear within ~10s of workflow start; refresh after the first agent turn completes.'
		);
	}
	return redirect(302, href);
};
