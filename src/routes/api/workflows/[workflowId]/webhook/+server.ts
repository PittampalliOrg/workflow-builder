import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowExecutionControlResult } from '$lib/server/application/workflow-execution-control';

// ---------------------------------------------------------------------------
// CORS headers — webhook callers may be cross-origin
// ---------------------------------------------------------------------------

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function corsJson(data: unknown, status = 200) {
	return json(data, { status, headers: corsHeaders });
}

// ---------------------------------------------------------------------------
// OPTIONS — CORS preflight
// ---------------------------------------------------------------------------

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, { status: 204, headers: corsHeaders });
};

// ---------------------------------------------------------------------------
// POST /api/workflows/[workflowId]/webhook
//
// Public webhook URL for external services to trigger workflow executions.
//
// Auth: requires a valid API key belonging to the workflow owner via
//       Authorization: Bearer wfb_...
//
// Application service pipeline:
// 1. Look up workflow by ID
// 2. Validate API key ownership
// 3. Verify the workflow has a webhook trigger configured
// 4. De-duplicate (reject if an execution is already running)
// 5. Create execution record
// 6. Start SW 1.0 workflow via orchestrator
// 7. Return execution ID immediately
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const { workflowId } = params;
		const body = await request.json().catch(() => ({}));
		return workflowExecutionControlCorsResponse(
			await getApplicationAdapters().workflowExecutionControl.startWebhookExecution({
				workflowId,
				authorizationHeader: request.headers.get('Authorization'),
				body: body as Record<string, unknown>
			})
		);
	} catch (err) {
		console.error('[Webhook] Failed to start workflow execution:', err);
		return corsJson(
			{ error: err instanceof Error ? err.message : 'Failed to execute workflow' },
			500
		);
	}
};

function workflowExecutionControlCorsResponse(result: WorkflowExecutionControlResult) {
	if (result.status === 'error') {
		return corsJson({ error: result.message }, result.httpStatus);
	}
	return corsJson(result.body, result.httpStatus ?? 200);
}
