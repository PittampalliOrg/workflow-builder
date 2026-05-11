import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	logTraceFeedback,
	resolveMlflowTraceIdForExecution
} from '$lib/server/observability/mlflow';

/**
 * POST /api/observability/mlflow/executions/[executionId]/feedback
 *
 * Phase 3b of the MLflow 3.12 enhancement plan
 * (research-the-most-popular-stateful-hinton.md).
 *
 * Records a user's feedback on a workflow run's trace. The UI sends
 * {value: 1.0|0.0, name: "user_rating", rationale: "<optional comment>"}.
 * We resolve executionId → trace_id via the DB (Phase 1's
 * `workflow_executions.primary_trace_id`), then POST to the
 * orchestrator's /api/v2/observability/feedback endpoint which wraps
 * `mlflow.log_feedback(...)`. The persisted assessment appears in
 * MLflow's Trace Detail view under the Assessments tab.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const executionId = params.executionId?.trim();
	if (!executionId) return error(400, 'executionId is required');

	if (!locals.session?.userId) return error(401, 'Authentication required');

	let body: {
		value?: number | string | boolean | null;
		name?: string;
		rationale?: string | null;
		sourceId?: string;
		metadata?: Record<string, unknown> | null;
	} = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return error(400, 'Invalid JSON body');
	}

	const traceId = await resolveMlflowTraceIdForExecution(executionId);
	if (!traceId) {
		return error(
			404,
			'No MLflow trace recorded yet for this execution. Wait ~10 seconds after workflow start, then retry.'
		);
	}

	const result = await logTraceFeedback({
		traceId,
		name: body.name ?? 'user_rating',
		value: body.value ?? null,
		rationale: body.rationale ?? null,
		sourceType: 'HUMAN',
		sourceId: body.sourceId ?? locals.session.email ?? locals.session.userId,
		metadata: body.metadata ?? null
	});

	if (!result) {
		return error(502, 'MLflow feedback failed to persist');
	}

	return json({
		ok: true,
		executionId,
		traceId,
		assessmentId: result.assessmentId
	});
};
