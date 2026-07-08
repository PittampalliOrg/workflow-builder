import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { ensureTraceAnalysisWorkflow } from '$lib/server/observability/trace-analysis-workflow';

/**
 * POST /api/observability/executions/[executionId]/deep-analysis
 *
 * Launch the multi-agent `trace-deep-analysis` dynamic-script workflow
 * against this execution (the platform analyzing itself): four parallel lens
 * reviewers with the trace_* MCP tools, then a schema'd synthesis returning a
 * TraceAnalysisReport. The target workflow's script + name ride in as args so
 * improvements can propose complete revised scripts for one-click apply.
 *
 * Returns { analysisExecutionId, targetWorkflowId, targetWorkflowName }.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const userId = locals.session.userId;
	const projectId = locals.session.projectId ?? null;
	if (!projectId) return error(400, 'No active project');

	const app = getApplicationAdapters();
	const context = await app.workflowData.getObservabilityServiceGraphContext({
		userId,
		projectId,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');

	// Target workflow (for the script + name the synthesizer needs).
	let targetWorkflowId: string | null = null;
	let targetWorkflowName: string | null = null;
	let targetScript: string | null = null;
	const workflowId = (context.execution as { workflowId?: string | null }).workflowId ?? null;
	if (workflowId) {
		const wf = (await app.workflowData.getWorkflowByRef({
			workflowId,
			lookup: 'id'
		})) as { id: string; name: string; spec?: { script?: unknown } | null } | null;
		if (wf) {
			targetWorkflowId = wf.id;
			targetWorkflowName = wf.name;
			targetScript = typeof wf.spec?.script === 'string' ? wf.spec.script : null;
		}
	}

	const ensured = await ensureTraceAnalysisWorkflow({ userId, projectId });
	if ('error' in ensured) return error(500, `Could not seed analysis workflow: ${ensured.error}`);

	const result = await app.workflowExecutionControl.executeWorkflow({
		workflowId: ensured.workflowId,
		body: {
			input: {
				executionId: params.executionId,
				...(targetScript ? { script: targetScript } : {}),
				...(targetWorkflowName ? { workflowName: targetWorkflowName } : {})
			},
			budgetTotal: 400_000
		},
		projectId,
		userId
	});
	if (result.status === 'error') return error(result.httpStatus, result.message);
	const body = result.body as { executionId?: string };
	if (!body?.executionId) return error(500, 'Analysis run did not start');

	return json(
		{ analysisExecutionId: body.executionId, targetWorkflowId, targetWorkflowName },
		{ status: 201 }
	);
};
