import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { isSWWorkflow, startWorkflowRun } from '$lib/server/workflows/start-run';

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
// Pipeline:
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
		const { workflowData } = getApplicationAdapters();

		// 1. Look up the workflow
		const workflow = await workflowData.getWorkflowByRef({ workflowId, lookup: 'id' });

		if (!workflow) {
			return corsJson({ error: 'Workflow not found' }, 404);
		}

		// 2. Validate API key — must belong to the workflow owner
		const authHeader = request.headers.get('Authorization');
		const apiKeyValidation = await workflowData.validateApiKeyForUser({
			authorizationHeader: authHeader,
			userId: workflow.userId
		});

		if (!apiKeyValidation.valid) {
			return corsJson(
				{ error: apiKeyValidation.error },
				apiKeyValidation.statusCode || 401
			);
		}

		// 3. Verify this is a webhook-triggered workflow
		const nodes = workflow.nodes as Array<{ data: { type: string; config?: { triggerType?: string } } }>;
		const triggerNode = nodes.find((node) => node.data.type === 'trigger');

		if (!triggerNode || triggerNode.data.config?.triggerType !== 'Webhook') {
			return corsJson(
				{ error: 'This workflow is not configured for webhook triggers' },
				400
			);
		}

		// 4. Validate SW 1.0 spec
		const spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
		if (!spec || !isSWWorkflow(spec)) {
			return corsJson(
				{ error: 'Workflow does not have a valid CNCF Serverless Workflow 1.0 spec' },
				400
			);
		}

		// 5. De-duplicate: reject if there is already a running execution
		const runningExecution = await workflowData.getRunningWorkflowExecution(workflowId);

		if (runningExecution) {
			return corsJson(
				{
					error: 'A workflow execution is already running',
					existingExecutionId: runningExecution.id
				},
				409
			);
		}

		// 6. Parse request body (empty body is fine)
		const body = await request.json().catch(() => ({}));

		const result = await startWorkflowRun({
			workflowId,
			triggerData: body as Record<string, unknown>,
			userId: workflow.userId,
			triggerSource: 'webhook'
		});
		if (!result.ok) {
			return corsJson({ error: result.error }, result.status);
		}

		return corsJson({
			executionId: result.executionId,
			status: 'running'
		});
	} catch (err) {
		console.error('[Webhook] Failed to start workflow execution:', err);
		return corsJson(
			{ error: err instanceof Error ? err.message : 'Failed to execute workflow' },
		500
	);
	}
};
