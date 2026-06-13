import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import { workflows, workflowExecutions } from '$lib/server/db/schema';
import { validateInternalToken } from '$lib/server/internal-auth';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { getMissingRequiredTriggerFields } from '$lib/server/workflows/trigger-validation';
import { getRemovedSw10AgentCallsError } from '$lib/server/workflows/sw10-agent-validation';
import {
	AgentRefResolutionError,
	resolveSpecAgentRefs
} from '$lib/server/agents/resolver';
import {
	applyWorkflowInputDefaults,
	getPromptExpansionConfig
} from '$lib/utils/workflow-input-config';
import { expandGreenfieldPromptInput } from '$lib/server/workflows/greenfield-prompt';
import {
	buildWorkflowSessionId,
	ensureWorkflowTraceparentHeader,
	injectWorkflowSessionHeaders,
	workflowTraceIdFromTraceparent
} from '$lib/server/observability/workflow-session';
import {
	safeCreateWorkflowExecutionMlflowRun,
	safeFinishMlflowRun,
	safePrecreateMlflowTrace
} from '$lib/server/observability/mlflow-lifecycle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecuteBody = {
	workflowId?: string;
	workflowName?: string;
	triggerData?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSWWorkflow(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== 'object' || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return (
		doc.dsl === '1.0.0' && typeof doc.namespace === 'string' && typeof doc.name === 'string'
	);
}

/**
 * Resolve a workflow by ID or by name (preferring public visibility).
 * Matches the Next.js `resolveInternalWorkflow` logic.
 */
async function resolveWorkflow(input: {
	workflowId?: string;
	workflowName?: string;
}): Promise<(typeof workflows.$inferSelect) | null> {
	const workflowId = input.workflowId?.trim();
	if (workflowId) {
		const [row] = await db!
			.select()
			.from(workflows)
			.where(eq(workflows.id, workflowId))
			.limit(1);
		return row ?? null;
	}

	const workflowName = input.workflowName?.trim();
	if (!workflowName) return null;

	const candidates = await db!
		.select()
		.from(workflows)
		.where(eq(workflows.name, workflowName))
		.orderBy(desc(workflows.updatedAt))
		.limit(20);

	if (candidates.length === 0) return null;
	return candidates.find((w) => w.visibility === 'public') ?? candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/execute
//
// Called by internal services to register and start a workflow execution.
// Creates a DB execution record, then starts the workflow via the Dapr
// orchestrator. (The original dapr-swe caller was retired; source removed.)
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
//
// Body:
//   { workflowId?: string, workflowName?: string, triggerData?: object }
//
// Returns:
//   { success: true, executionId, instanceId, workflowId, workflowName, status }
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!db) {
		return json({ error: 'Database not configured' }, { status: 503 });
	}
	try {
		await assertExecutionReadModelColumns();
	} catch (schemaError) {
		console.error(
			'[internal/agent/workflows/execute] execution read-model schema check failed:',
			schemaError
		);
		return json(
			{
				error:
					schemaError instanceof Error
						? schemaError.message
						: 'Execution read-model migration is required'
			},
			{ status: 503 }
		);
	}

	const body = (await request.json().catch(() => ({}))) as ExecuteBody;

	const workflow = await resolveWorkflow({
		workflowId: body.workflowId,
		workflowName: body.workflowName
	});

	if (!workflow) {
		return json({ error: 'Workflow not found' }, { status: 404 });
	}

	let triggerData = body.triggerData ?? {};
	let spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
	if (spec && isSWWorkflow(spec)) {
		const removedAgentCallsError = getRemovedSw10AgentCallsError(spec);
		if (removedAgentCallsError) {
			return json({ error: removedAgentCallsError }, { status: 400 });
		}
		triggerData = applyWorkflowInputDefaults(spec, triggerData);
		if (getPromptExpansionConfig(spec)?.requiresExpansion) {
			triggerData = await expandGreenfieldPromptInput(spec, triggerData);
		}
		const missingTriggerFields = getMissingRequiredTriggerFields(spec, triggerData);
		if (missingTriggerFields.length > 0) {
			return json(
				{
					error: `Missing required workflow input fields: ${missingTriggerFields.join(', ')}`
				},
				{ status: 400 }
			);
		}
		try {
			spec = await resolveSpecAgentRefs(spec, { triggerData });
		} catch (resolveErr) {
			if (resolveErr instanceof AgentRefResolutionError) {
				return json({ error: resolveErr.message }, { status: 400 });
			}
			console.error('[internal/agent/workflows/execute] agent ref resolution failed:', resolveErr);
			return json(
				{
					error:
						resolveErr instanceof Error ? resolveErr.message : 'Agent ref resolution failed'
				},
				{ status: 500 }
			);
		}
	}

	try {
		// 1. Create execution record
		const [execution] = await db
			.insert(workflowExecutions)
			.values({
				workflowId: workflow.id,
				userId: workflow.userId,
				status: 'running',
				phase: 'running',
				progress: 0,
				input: triggerData,
				executionIrVersion: 'sw-1.0.0'
			})
			.returning({ id: workflowExecutions.id });

		// 2. Start workflow via orchestrator
		const orchestratorUrl = workflow.daprOrchestratorUrl || getOrchestratorUrl();

		if (!spec || !isSWWorkflow(spec)) {
			throw new Error(
				'Workflow does not have a valid SW 1.0 spec. Save or publish the workflow before executing it.'
			);
		}

		let instanceId: string | undefined;
		const sessionId = buildWorkflowSessionId(execution.id);
		const mlflowContext = await safeCreateWorkflowExecutionMlflowRun({
			executionId: execution.id,
			workflowId: workflow.id,
			workflowName: workflow.name,
			projectId: workflow.projectId ?? null,
			userId: workflow.userId ?? null
		});

		try {
			const headers = injectWorkflowSessionHeaders(
				ensureWorkflowTraceparentHeader({ 'Content-Type': 'application/json' }),
				{
					sessionId,
					workflowExecutionId: execution.id,
					workflowId: workflow.id,
					traceGroupId: execution.id,
					mlflowExperimentId:
						mlflowContext?.traceExperimentId ?? mlflowContext?.experimentId,
					mlflowRunId: mlflowContext?.runId,
					mlflowParentRunId: mlflowContext?.parentRunId
				}
			);
			const traceContext = {
				traceparent: headers.traceparent,
				tracestate: headers.tracestate,
				baggage: headers.baggage
			};
			await safePrecreateMlflowTrace({
				traceId: workflowTraceIdFromTraceparent(headers.traceparent),
				experimentId: mlflowContext?.traceExperimentId ?? mlflowContext?.experimentId,
					name: `${workflow.id}/${execution.id}`,
					metadata: {
						'mlflow.sourceRun': mlflowContext?.runId
					},
				tags: {
					'workflow_builder.kind': 'workflow_execution',
					'workflow_builder.workflow_id': workflow.id,
					'workflow_builder.workflow_execution_id': execution.id,
					'workflow.execution.id': execution.id,
					'mlflow.run_id': mlflowContext?.runId
				}
			});
			const res = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					workflow: spec,
					workflowId: workflow.id,
					triggerData,
					dbExecutionId: execution.id,
					mlflowContext,
					traceContext
				})
			});

			if (!res.ok) {
				const errText = await res.text().catch(() => 'Unknown error');
				void safeFinishMlflowRun({
					runId: mlflowContext?.runId,
					status: 'FAILED'
				});
				throw new Error(`Orchestrator error (${res.status}): ${errText}`);
			}

			const result = await res.json();
			instanceId = result.instanceId;
		} catch (err) {
			// Mark execution as failed if orchestrator start fails
			await db
				.update(workflowExecutions)
				.set({
					status: 'error',
					phase: 'failed',
					error: err instanceof Error ? err.message : 'Failed to start workflow execution',
					completedAt: new Date()
				})
				.where(eq(workflowExecutions.id, execution.id));
			throw err;
		}

		// 3. Update execution with Dapr instance ID
		if (instanceId) {
			await db
				.update(workflowExecutions)
				.set({
					daprInstanceId: instanceId,
					phase: 'running',
					progress: 0,
					workflowSessionId: sessionId ?? execution.id
				})
				.where(eq(workflowExecutions.id, execution.id));
		}

		return json({
			success: true,
			executionId: execution.id,
			instanceId: instanceId ?? null,
			workflowId: workflow.id,
			workflowName: workflow.name,
			status: 'running'
		});
	} catch (err) {
		console.error('[internal/agent/workflows/execute] Failed:', err);
		return json(
			{
				error: err instanceof Error ? err.message : 'Failed to start workflow execution'
			},
			{ status: 500 }
		);
	}
};
