import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
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
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const mode = (url.searchParams.get('mode') ?? 'service') as ServiceGraphMode;
	const scope = (url.searchParams.get('scope') ?? 'execution') as ServiceGraphScope;
	const executionId = url.searchParams.get('executionId') ?? undefined;
	const workflowIdParam = url.searchParams.get('workflowId') ?? undefined;
	const windowParam = (url.searchParams.get('window') ?? '1h') as ServiceGraphWindow;

	if (mode !== 'service' && mode !== 'step') return error(400, 'Invalid mode');
	if (scope !== 'execution' && scope !== 'window') return error(400, 'Invalid scope');
	const windowSeconds = SERVICE_GRAPH_WINDOWS[windowParam] ?? SERVICE_GRAPH_WINDOWS['1h'];

	// Load + scope-validate the execution (and its workflow) when scope=execution.
	let execution: typeof workflowExecutions.$inferSelect | null = null;
	let workflow: typeof workflows.$inferSelect | null = null;

	if (scope === 'execution') {
		if (!executionId) return error(400, 'executionId is required when scope=execution');
		const [row] = await db
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (!row || !isResourceInScope(row, locals.session)) {
			return error(404, 'Execution not found');
		}
		execution = row;
		if (row.workflowId) {
			const [wf] = await db
				.select()
				.from(workflows)
				.where(eq(workflows.id, row.workflowId))
				.limit(1);
			if (wf && isResourceInScope(wf, locals.session)) workflow = wf;
		}
	}

	// Resolve the workflow for step+window (and as an optional service filter).
	const targetWorkflowId = workflowIdParam ?? workflow?.id;
	if (mode === 'step' && scope === 'window' && !targetWorkflowId) {
		return error(400, 'workflowId is required for step + window');
	}
	if (!workflow && targetWorkflowId) {
		const [wf] = await db
			.select()
			.from(workflows)
			.where(eq(workflows.id, targetWorkflowId))
			.limit(1);
		if (!wf || !isResourceInScope(wf, locals.session)) {
			return error(404, 'Workflow not found');
		}
		workflow = wf;
	}

	const query: ServiceGraphQuery = {
		mode,
		scope,
		executionId: scope === 'execution' ? executionId : undefined,
		workflowId: targetWorkflowId,
		windowSeconds
	};

	const payload = await buildServiceGraph({ query, execution, workflow });
	return json(payload);
};
