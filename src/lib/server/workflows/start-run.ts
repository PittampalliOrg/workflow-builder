/**
 * The single, canonical "start a workflow run" path.
 *
 * Every workflow start — the internal execute endpoint, the public webhook, and
 * the event-driven `workflow.triggers` spine — funnels through `startWorkflowRun()`
 * so there is ONE place that resolves the workflow, applies input defaults +
 * validation + agent-ref resolution, creates the `workflow_executions` row, and
 * starts the Dapr orchestrator workflow.
 *
 * Idempotency: callers driven by at-least-once delivery (pub/sub triggers) pass a
 * deterministic `executionId` (derived from a `dedupKey`) + `idempotent: true`.
 * A re-delivery finds the existing row and returns it as a no-op — and because the
 * orchestrator stamps the Dapr instance id as `sw-<name>-exec-<executionId>`, the
 * instance id is deterministic too, so Dapr also dedups the start.
 */
import { eq, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import { workflows, workflowExecutions } from '$lib/server/db/schema';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { getMissingRequiredTriggerFields } from '$lib/server/workflows/trigger-validation';
import { getRemovedSw10AgentCallsError } from '$lib/server/workflows/sw10-agent-validation';
import { AgentRefResolutionError, resolveSpecAgentRefs } from '$lib/server/agents/resolver';
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

export function isSWWorkflow(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== 'object' || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return doc.dsl === '1.0.0' && typeof doc.namespace === 'string' && typeof doc.name === 'string';
}

/** Resolve a workflow by ID or by name (preferring public visibility). */
export async function resolveWorkflow(input: {
	workflowId?: string;
	workflowName?: string;
}): Promise<typeof workflows.$inferSelect | null> {
	const workflowId = input.workflowId?.trim();
	if (workflowId) {
		const [row] = await db!.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
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

export type StartWorkflowResult =
	| {
			ok: true;
			executionId: string;
			instanceId: string | null;
			workflowId: string;
			workflowName: string;
			status: 'running';
			reused: boolean;
	  }
	| { ok: false; status: number; error: string };

export interface StartWorkflowOptions {
	workflowId?: string;
	workflowName?: string;
	triggerData?: Record<string, unknown>;
	/** Deterministic execution id for idempotent (at-least-once) callers. */
	executionId?: string;
	/** When true + executionId set: a pre-existing row short-circuits as a no-op. */
	idempotent?: boolean;
	/** Set for event-driven runs (the firing trigger's id) → stamped on the
	 *  execution row for the concurrency gate + capacity lens. */
	triggerSource?: string;
	/** Resume/fork: skip every top-level node before this one (the interpreter
	 *  reuses the retained workspace and runs only from here onward). */
	resumeFromNode?: string;
	/** Resume/fork: stable shared-workspace key (the SOURCE run's id) so the
	 *  resumed nodes re-mount the original /sandbox/work. */
	workspaceExecutionId?: string;
	/** Hermetic fork: seed this run's fresh workspace from the SOURCE run's subPath
	 *  (read-only copy at sandbox startup) so repeated forks don't share + drift. */
	seedWorkspaceFrom?: string;
	/** Resume/fork lineage: the source execution this run was forked from. */
	rerunOfExecutionId?: string;
	rerunSourceInstanceId?: string;
}

export async function startWorkflowRun(
	opts: StartWorkflowOptions
): Promise<StartWorkflowResult> {
	if (!db) return { ok: false, status: 503, error: 'Database not configured' };
	try {
		await assertExecutionReadModelColumns();
	} catch (schemaError) {
		return {
			ok: false,
			status: 503,
			error:
				schemaError instanceof Error
					? schemaError.message
					: 'Execution read-model migration is required'
		};
	}

	const workflow = await resolveWorkflow({
		workflowId: opts.workflowId,
		workflowName: opts.workflowName
	});
	if (!workflow) return { ok: false, status: 404, error: 'Workflow not found' };

	// Idempotency: a deterministic id that already exists → return it (no-op).
	if (opts.executionId && opts.idempotent) {
		const [existing] = await db
			.select({ id: workflowExecutions.id, daprInstanceId: workflowExecutions.daprInstanceId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, opts.executionId))
			.limit(1);
		if (existing) {
			return {
				ok: true,
				executionId: existing.id,
				instanceId: existing.daprInstanceId ?? null,
				workflowId: workflow.id,
				workflowName: workflow.name,
				status: 'running',
				reused: true
			};
		}
	}

	let triggerData = opts.triggerData ?? {};
	let spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
	if (spec && isSWWorkflow(spec)) {
		const removedAgentCallsError = getRemovedSw10AgentCallsError(spec);
		if (removedAgentCallsError) return { ok: false, status: 400, error: removedAgentCallsError };
		triggerData = applyWorkflowInputDefaults(spec, triggerData);
		if (getPromptExpansionConfig(spec)?.requiresExpansion) {
			triggerData = await expandGreenfieldPromptInput(spec, triggerData);
		}
		const missing = getMissingRequiredTriggerFields(spec, triggerData);
		if (missing.length > 0) {
			return { ok: false, status: 400, error: `Missing required workflow input fields: ${missing.join(', ')}` };
		}
		try {
			spec = await resolveSpecAgentRefs(spec, { triggerData });
		} catch (resolveErr) {
			if (resolveErr instanceof AgentRefResolutionError) {
				return { ok: false, status: 400, error: resolveErr.message };
			}
			return {
				ok: false,
				status: 500,
				error: resolveErr instanceof Error ? resolveErr.message : 'Agent ref resolution failed'
			};
		}
	}

	if (!spec || !isSWWorkflow(spec)) {
		return {
			ok: false,
			status: 400,
			error:
				'Workflow does not have a valid SW 1.0 spec. Save or publish the workflow before executing it.'
		};
	}

	// 1. Create execution record (explicit deterministic id when provided).
	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			...(opts.executionId ? { id: opts.executionId } : {}),
			workflowId: workflow.id,
			userId: workflow.userId,
			status: 'running',
			phase: 'running',
			progress: 0,
			input: triggerData,
			// Snapshot the EXECUTED spec (agent-refs resolved) so each run — and each
			// fork — has the exact spec it ran, enabling per-branch "what changed vs
			// parent" diffs. Evals/benchmarks create their own rows with a richer
			// executionIr, so this generic path never clobbers them.
			executionIr: { spec, triggerData },
			executionIrVersion: 'sw-1.0.0',
			...(opts.triggerSource ? { triggerSource: opts.triggerSource } : {}),
			...(opts.rerunOfExecutionId ? { rerunOfExecutionId: opts.rerunOfExecutionId } : {}),
			...(opts.rerunSourceInstanceId
				? { rerunSourceInstanceId: opts.rerunSourceInstanceId }
				: {}),
			// Persist the fork point so the lineage tree can label "fork @<node>".
			...(opts.resumeFromNode ? { resumeFromNode: opts.resumeFromNode } : {})
		})
		.returning({ id: workflowExecutions.id });

	const orchestratorUrl = workflow.daprOrchestratorUrl || getOrchestratorUrl();
	const sessionId = buildWorkflowSessionId(execution.id);
	const mlflowContext = await safeCreateWorkflowExecutionMlflowRun({
		executionId: execution.id,
		workflowId: workflow.id,
		workflowName: workflow.name,
		projectId: workflow.projectId ?? null,
		userId: workflow.userId ?? null
	});

	let instanceId: string | undefined;
	try {
		const headers = injectWorkflowSessionHeaders(
			ensureWorkflowTraceparentHeader({ 'Content-Type': 'application/json' }),
			{
				sessionId,
				workflowExecutionId: execution.id,
				workflowId: workflow.id,
				traceGroupId: execution.id,
				mlflowExperimentId: mlflowContext?.traceExperimentId ?? mlflowContext?.experimentId,
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
			metadata: { 'mlflow.sourceRun': mlflowContext?.runId },
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
				traceContext,
				// Resume/fork: skip the prefix + reuse the source workspace. Omitted
				// (undefined) for normal runs → interpreter defaults apply.
				...(opts.resumeFromNode ? { resumeFromNode: opts.resumeFromNode } : {}),
				...(opts.workspaceExecutionId
					? { workspaceExecutionId: opts.workspaceExecutionId }
					: {}),
				...(opts.seedWorkspaceFrom ? { seedWorkspaceFrom: opts.seedWorkspaceFrom } : {})
			})
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => 'Unknown error');
			void safeFinishMlflowRun({ runId: mlflowContext?.runId, status: 'FAILED' });
			throw new Error(`Orchestrator error (${res.status}): ${errText}`);
		}
		const result = await res.json();
		instanceId = result.instanceId;
	} catch (err) {
		await db
			.update(workflowExecutions)
			.set({
				status: 'error',
				phase: 'failed',
				error: err instanceof Error ? err.message : 'Failed to start workflow execution',
				completedAt: new Date()
			})
			.where(eq(workflowExecutions.id, execution.id));
		return {
			ok: false,
			status: 500,
			error: err instanceof Error ? err.message : 'Failed to start workflow execution'
		};
	}

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

	return {
		ok: true,
		executionId: execution.id,
		instanceId: instanceId ?? null,
		workflowId: workflow.id,
		workflowName: workflow.name,
		status: 'running',
		reused: false
	};
}
