import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq, and } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import { workflows, workflowExecutions, apiKeys } from '$lib/server/db/schema';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

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
// API key validation
// ---------------------------------------------------------------------------

async function validateApiKey(
	authHeader: string | null,
	workflowUserId: string
): Promise<{ valid: boolean; error?: string; statusCode?: number }> {
	if (!authHeader) {
		return { valid: false, error: 'Missing Authorization header', statusCode: 401 };
	}

	const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

	if (!key?.startsWith('wfb_')) {
		return { valid: false, error: 'Invalid API key format', statusCode: 401 };
	}

	const keyHash = createHash('sha256').update(key).digest('hex');

	const apiKey = await db!
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.keyHash, keyHash))
		.limit(1)
		.then((rows) => rows[0]);

	if (!apiKey) {
		return { valid: false, error: 'Invalid API key', statusCode: 401 };
	}

	if (apiKey.userId !== workflowUserId) {
		return { valid: false, error: 'You do not have permission to run this workflow', statusCode: 403 };
	}

	// Fire-and-forget: update last used timestamp
	db!
		.update(apiKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(apiKeys.id, apiKey.id))
		.catch(() => {});

	return { valid: true };
}

// ---------------------------------------------------------------------------
// SW 1.0 spec validation
// ---------------------------------------------------------------------------

function isSWWorkflow(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== 'object' || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return doc.dsl === '1.0.0' && typeof doc.namespace === 'string' && typeof doc.name === 'string';
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

		if (!db) {
			return corsJson({ error: 'Database not configured' }, 503);
		}
		try {
			await assertExecutionReadModelColumns();
		} catch (schemaError) {
			console.error('[Webhook] execution read-model schema check failed:', schemaError);
			return corsJson(
				{
					error:
						schemaError instanceof Error
							? schemaError.message
							: 'Execution read-model migration is required'
				},
				503
			);
		}

		// 1. Look up the workflow
		const [workflow] = await db
			.select()
			.from(workflows)
			.where(eq(workflows.id, workflowId))
			.limit(1);

		if (!workflow) {
			return corsJson({ error: 'Workflow not found' }, 404);
		}

		// 2. Validate API key — must belong to the workflow owner
		const authHeader = request.headers.get('Authorization');
		const apiKeyValidation = await validateApiKey(authHeader, workflow.userId);

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
		const [runningExecution] = await db
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(
				and(
					eq(workflowExecutions.workflowId, workflowId),
					eq(workflowExecutions.status, 'running')
				)
			)
			.limit(1);

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

		// 7. Create execution record
		let execution;
		try {
			[execution] = await db
				.insert(workflowExecutions)
				.values({
					workflowId,
					userId: workflow.userId,
					status: 'running',
					phase: 'running',
					progress: 0,
					input: body as Record<string, unknown>,
					executionIrVersion: 'sw-1.0.0'
				})
				.returning();
		} catch (dbErr) {
			console.error('[Webhook] DB insert failed:', dbErr);
			return corsJson({ error: 'Failed to create execution record' }, 500);
		}

		console.log('[Webhook] Created execution:', execution.id);

		// 8. Start workflow via orchestrator (fire-and-forget — return immediately)
		const orchestratorUrl = getOrchestratorUrl();

		startWorkflowInBackground(
			orchestratorUrl,
			workflowId,
			execution.id,
			spec,
			body as Record<string, unknown>
		);

		return corsJson({
			executionId: execution.id,
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

// ---------------------------------------------------------------------------
// Background workflow start (not awaited by the handler)
// ---------------------------------------------------------------------------

function startWorkflowInBackground(
	orchestratorUrl: string,
	workflowId: string,
	executionId: string,
	spec: Record<string, unknown>,
	triggerData: Record<string, unknown>
) {
	(async () => {
		try {
			const res = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workflow: spec,
					workflowId,
					triggerData,
					dbExecutionId: executionId
				})
			});

			if (!res.ok) {
				const errText = await res.text().catch(() => 'Unknown error');
				throw new Error(`SW workflow failed: ${res.status} ${errText}`);
			}

			const result = await res.json();

			await db!
				.update(workflowExecutions)
				.set({
					daprInstanceId: result.instanceId,
					workflowSessionId: executionId
				})
				.where(eq(workflowExecutions.id, executionId));

			console.log('[Webhook] SW workflow started:', result.instanceId);
		} catch (err) {
			console.error('[Webhook] Error during Dapr execution:', err);

			await db!
				.update(workflowExecutions)
				.set({
					status: 'error',
					error: (err instanceof Error ? err.message : 'Unknown error').slice(0, 500),
					completedAt: new Date()
				})
				.where(eq(workflowExecutions.id, executionId));
		}
	})();
}
