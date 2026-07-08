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
import { getOrchestratorUrl } from '$lib/server/dapr-client';
import { getMissingRequiredTriggerFields } from '$lib/server/workflows/trigger-validation';
import { getRemovedSw10AgentCallsError } from '$lib/server/workflows/sw10-agent-validation';
import { validateTriggerModel } from '$lib/server/workflows/model-validation';
import { AgentRefResolutionError, resolveSpecAgentRefs } from '$lib/server/agents/resolver';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowDefinition } from '$lib/server/application/ports';
import {
	applyWorkflowInputDefaults,
	getPromptExpansionConfig
} from '$lib/utils/workflow-input-config';
import { expandGreenfieldPromptInput } from '$lib/server/workflows/greenfield-prompt';
import {
	buildWorkflowSessionId,
	ensureWorkflowTraceparentHeader,
	injectWorkflowSessionHeaders
} from '$lib/server/observability/workflow-session';
import { prewarmWorkflowEntrySessions } from '$lib/server/sessions/prewarm';
import { validateDynamicScriptSpec } from '$lib/server/workflows/dynamic-script-validation';

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
}): Promise<WorkflowDefinition | null> {
	return getApplicationAdapters().workflowDefinitions.getByRef(input);
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
	/** Run input. SW 1.0 requires an object (trigger fields); dynamic-script
	 *  accepts ANY JSON value verbatim (the script's `args` global) and treats
	 *  `undefined` as "not provided" (args global is undefined). */
	triggerData?: unknown;
	/** Deterministic execution id for idempotent (at-least-once) callers. */
	executionId?: string;
	/** When true + executionId set: a pre-existing row short-circuits as a no-op. */
	idempotent?: boolean;
	/** Set for event-driven runs (the firing trigger's id) → stamped on the
	 *  execution row for the concurrency gate + capacity lens. */
	triggerSource?: string;
	/** Interactive caller to stamp on the execution row; defaults to workflow owner. */
	userId?: string;
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
	/** Dynamic-script resume-after-edit: the orchestrator imports this source
	 *  execution's `done` journal rows so unchanged calls resolve without new
	 *  sessions. */
	journalImportFromExecutionId?: string;
	/** Dynamic-script token budget for the run; overrides spec.defaults.budgetTotal. */
	budgetTotal?: number | null;
}

export async function startWorkflowRun(
	opts: StartWorkflowOptions
): Promise<StartWorkflowResult> {
	let app: ReturnType<typeof getApplicationAdapters>;
	try {
		app = getApplicationAdapters();
	} catch (adapterError) {
		return {
			ok: false,
			status: 503,
			error: adapterError instanceof Error ? adapterError.message : 'Application adapters unavailable'
		};
	}
	try {
		await app.workflowData.assertExecutionReadModelReady();
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

	const workflow = await app.workflowDefinitions.getByRef({
		workflowId: opts.workflowId,
		workflowName: opts.workflowName
	});
	if (!workflow) return { ok: false, status: 404, error: 'Workflow not found' };

	// Idempotency: a deterministic id that already exists → return it (no-op).
	if (opts.executionId && opts.idempotent) {
		const existing = await app.workflowExecutions.getById(opts.executionId);
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

	// Dynamic-script engine: a completely different start path from SW 1.0 — no
	// agent-ref resolution, no trigger-field validation, no SW spec gate. The JS
	// script runs in the orchestrator's re-execution pump against the evaluator.
	if (workflow.engineType === "dynamic-script") {
		return startDynamicScriptRun(app, workflow, opts);
	}

	// SW 1.0 trigger inputs are field-keyed objects; coerce non-objects to {}.
	let triggerData: Record<string, unknown> =
		opts.triggerData && typeof opts.triggerData === 'object' && !Array.isArray(opts.triggerData)
			? (opts.triggerData as Record<string, unknown>)
			: {};
	let spec = workflow.spec as Record<string, unknown> | null;
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
		const modelError = await validateTriggerModel(spec, triggerData, {
			modelCatalog: app.workflowData
		});
		if (modelError) return { ok: false, status: 400, error: modelError };
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
	const execution = await app.workflowExecutions.create({
		...(opts.executionId ? { id: opts.executionId } : {}),
		workflowId: workflow.id,
		userId: opts.userId ?? workflow.userId,
		// Scope the run to the workflow's project so event/trigger-started runs
		// (which have no user session context) still appear under the correct
		// workspace in the UI — the workspace-scoped run pages filter by projectId,
		// so a null here renders the run invisible ("empty" run page).
		projectId: workflow.projectId ?? null,
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
	});

	const orchestratorUrl = workflow.daprOrchestratorUrl || getOrchestratorUrl();
	const sessionId = buildWorkflowSessionId(execution.id);

	let instanceId: string | undefined;
	try {
		const headers = injectWorkflowSessionHeaders(
			ensureWorkflowTraceparentHeader({ 'Content-Type': 'application/json' }),
			{
				sessionId,
				workflowExecutionId: execution.id,
				workflowId: workflow.id,
				traceGroupId: execution.id
			}
		);
		const traceContext = {
			traceparent: headers.traceparent,
			tracestate: headers.tracestate,
			baggage: headers.baggage
		};
		void prewarmWorkflowEntrySessions({
			spec,
			executionId: execution.id,
			userId: opts.userId ?? workflow.userId,
			traceContext,
		}).catch(() => {});
		const result = await app.workflowScheduler.startSwWorkflow({
			orchestratorUrl,
			headers,
			workflow: spec,
				workflowId: workflow.id,
				triggerData,
				dbExecutionId: execution.id,
				traceContext,
				// Resume/fork: skip the prefix + reuse the source workspace. Omitted
			// (undefined) for normal runs → interpreter defaults apply.
			...(opts.resumeFromNode ? { resumeFromNode: opts.resumeFromNode } : {}),
			...(opts.workspaceExecutionId
				? { workspaceExecutionId: opts.workspaceExecutionId }
				: {}),
			...(opts.seedWorkspaceFrom ? { seedWorkspaceFrom: opts.seedWorkspaceFrom } : {})
		});
		instanceId = result.instanceId;
	} catch (err) {
		await app.workflowExecutions.markStartFailed({
			executionId: execution.id,
			error: err instanceof Error ? err.message : 'Failed to start workflow execution'
		});
		return {
			ok: false,
			status: 500,
			error: err instanceof Error ? err.message : 'Failed to start workflow execution'
		};
	}

	if (instanceId) {
		await app.workflowExecutions.attachSchedulerInstance({
			executionId: execution.id,
			instanceId,
			workflowSessionId: sessionId ?? execution.id
		});
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

/**
 * Start path for the dynamic-script engine. The workflow spec is
 * `{engine:'dynamic-script', script, meta, defaults?}`; there is no SW 1.0 spec,
 * no agent-ref resolution and no trigger-field validation. The `args` global is
 * the trigger data. Project scoping still applies (execution row carries the
 * workflow's projectId). The orchestrator's re-execution pump runs the script.
 */
async function startDynamicScriptRun(
	app: ReturnType<typeof getApplicationAdapters>,
	workflow: WorkflowDefinition,
	opts: StartWorkflowOptions
): Promise<StartWorkflowResult> {
	const spec = (workflow.spec ?? null) as Record<string, unknown> | null;
	const validation = validateDynamicScriptSpec(spec);
	if (!validation.ok) {
		return { ok: false, status: validation.status, error: validation.error };
	}
	const script = String((spec as Record<string, unknown>).script);
	const meta = validation.meta;
	// args is the script's VERBATIM input — any JSON value. undefined means "not
	// provided": the key is omitted end-to-end so the script's `args` global is
	// undefined (Workflow-tool parity). JSON serialization drops undefined keys,
	// which is exactly the wire behavior the orchestrator expects.
	const args = opts.triggerData;
	const defaults = (spec as Record<string, unknown>).defaults as
		| { budgetTotal?: number | null }
		| undefined;
	const budgetTotal =
		opts.budgetTotal ?? (defaults?.budgetTotal != null ? defaults.budgetTotal : null);

	const execution = await app.workflowExecutions.create({
		...(opts.executionId ? { id: opts.executionId } : {}),
		workflowId: workflow.id,
		userId: opts.userId ?? workflow.userId,
		projectId: workflow.projectId ?? null,
		status: 'running',
		phase: 'running',
		progress: 0,
		input: (args ?? undefined) as Record<string, unknown> | undefined,
		executionIr: { engine: 'dynamic-script', script, meta, args, budgetTotal },
		executionIrVersion: 'dynamic-script-1',
		...(opts.triggerSource ? { triggerSource: opts.triggerSource } : {}),
		...(opts.rerunOfExecutionId ? { rerunOfExecutionId: opts.rerunOfExecutionId } : {}),
		...(opts.rerunSourceInstanceId
			? { rerunSourceInstanceId: opts.rerunSourceInstanceId }
			: {})
	});

	const orchestratorUrl = workflow.daprOrchestratorUrl || getOrchestratorUrl();
	const sessionId = buildWorkflowSessionId(execution.id);

	let instanceId: string | undefined;
	try {
		const headers = injectWorkflowSessionHeaders(
			ensureWorkflowTraceparentHeader({ 'Content-Type': 'application/json' }),
			{
				sessionId,
				workflowExecutionId: execution.id,
				workflowId: workflow.id,
				traceGroupId: execution.id
			}
		);
		const traceContext = {
			traceparent: headers.traceparent,
			tracestate: headers.tracestate,
			baggage: headers.baggage
		};
		const result = await app.workflowScheduler.startScriptWorkflow({
			orchestratorUrl,
			headers,
			script,
			meta: meta as Record<string, unknown>,
			args,
			budgetTotal,
			...(opts.journalImportFromExecutionId
				? { journalImportFromExecutionId: opts.journalImportFromExecutionId }
				: {}),
			dbExecutionId: execution.id,
			workflowId: workflow.id,
			userId: opts.userId ?? workflow.userId,
			projectId: workflow.projectId ?? null,
			traceContext
		});
		instanceId = result.instanceId;
	} catch (err) {
		await app.workflowExecutions.markStartFailed({
			executionId: execution.id,
			error: err instanceof Error ? err.message : 'Failed to start dynamic-script execution'
		});
		return {
			ok: false,
			status: 500,
			error: err instanceof Error ? err.message : 'Failed to start dynamic-script execution'
		};
	}

	if (instanceId) {
		await app.workflowExecutions.attachSchedulerInstance({
			executionId: execution.id,
			instanceId,
			workflowSessionId: sessionId ?? execution.id
		});
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
