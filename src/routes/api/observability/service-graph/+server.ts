import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { redactDiagnosticEvidence } from '$lib/server/application/diagnostic-redaction';
import { buildServiceGraph } from '$lib/server/otel/service-graph';
import {
	SERVICE_GRAPH_WINDOWS,
	type ServiceGraphMode,
	type ServiceGraphQuery,
	type ServiceGraphScope,
	type ServiceGraphWindow
} from '$lib/types/service-graph';

/**
 * GET /api/observability/service-graph
 *
 * Query params:
 *   mode        service | step           (node model)
 *   scope       execution | window       (time scope)
 *   executionId <id>                     (required when scope=execution)
 *   window      5m|15m|1h|6h|24h         (when scope=window; default 1h)
 *   workflowId  <id>                     (required for step+window; optional filter elsewhere)
 *
 * Returns a ServiceGraphPayload. ClickHouse/DB failures degrade to an empty
 * graph with `meta.degraded=true` (HTTP 200) so the canvas shows an empty state
 * rather than an error boundary — matching the traces endpoint convention.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const application = getApplicationAdapters();

	const mode = (url.searchParams.get('mode') ?? 'service') as ServiceGraphMode;
	const scope = (url.searchParams.get('scope') ?? 'execution') as ServiceGraphScope;
	const executionId = url.searchParams.get('executionId') ?? undefined;
	const workflowIdParam = url.searchParams.get('workflowId') ?? undefined;
	const windowParam = (url.searchParams.get('window') ?? '1h') as ServiceGraphWindow;

	if (mode !== 'service' && mode !== 'step') return error(400, 'Invalid mode');
	if (scope !== 'execution' && scope !== 'window') return error(400, 'Invalid scope');
	const windowSeconds = SERVICE_GRAPH_WINDOWS[windowParam] ?? SERVICE_GRAPH_WINDOWS['1h'];

	if (scope === 'execution') {
		if (!executionId) return error(400, 'executionId is required when scope=execution');
	}

	// Resolve the workflow for step+window (and as an optional service filter).
	if (mode === 'step' && scope === 'window' && !workflowIdParam) {
		return error(400, 'workflowId is required for step + window');
	}
	const context = await application.workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId: scope === 'execution' ? executionId : undefined,
		workflowId: workflowIdParam
	});
	if (!context) {
		return error(404, scope === 'execution' ? 'Execution not found' : 'Workflow not found');
	}
	const executionEvidence =
		scope === 'execution' && context.execution
			? await application.workflowDiagnostics.getInvestigationEvidence({
					execution: context.execution,
					request: {
						categories: ['spans', 'llmSpans'],
						limits: { spans: 200, llmSpans: 20 }
					}
				})
			: undefined;

	const query: ServiceGraphQuery = {
		mode,
		scope,
		executionId: scope === 'execution' ? executionId : undefined,
		workflowId: context.targetWorkflowId ?? undefined,
		windowSeconds
	};
	const stepLogs =
		mode === 'step'
			? await application.workflowData.listObservabilityServiceGraphStepLogs({
					userId: locals.session.userId,
					projectId: locals.session.projectId ?? null,
					executionId: scope === 'execution' ? executionId : undefined,
					workflowId: scope === 'window' ? context.targetWorkflowId : undefined,
					windowSeconds,
					executionLimit: 2000
				})
			: undefined;
	if (mode === 'step' && stepLogs == null) {
		return error(404, scope === 'execution' ? 'Execution not found' : 'Workflow not found');
	}

	// Dynamic-script executions carry no SW step logs — their step graph is the
	// call journal. Loading it is cheap and returns [] for SW 1.0 runs, so we
	// probe unconditionally for step × execution.
	const scriptCallRows =
		mode === 'step' && scope === 'execution' && executionId
			? await application.scriptCalls.listInternal(executionId)
			: [];
	const scriptCalls = scriptCallRows.map((row) => ({
		callId: row.callId,
		seq: row.seq,
		kind: row.kind,
		label: row.label,
		phase: row.phase,
		status: row.status ?? 'null',
		sessionId: row.sessionId,
		retries: row.retries ?? 0,
		errorCode: row.errorCode
	}));

	const payload = await buildServiceGraph({
		query,
		execution: context.execution,
		workflow: context.workflow,
		stepLogs: stepLogs ?? undefined,
		scriptCalls,
		executionEvidence
	});
	return json(redactDiagnosticEvidence(payload), {
		headers: { 'cache-control': 'no-store' }
	});
};
