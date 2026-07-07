import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { startWorkflowRun } from '$lib/server/workflows/start-run';

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/execute
//
// Called by internal services to register and start a workflow execution.
// Thin wrapper over the canonical startWorkflowRun() helper (the single start
// path shared with the public webhook + the event-driven workflow.triggers spine).
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
// Body: { workflowId?, workflowName?, triggerData? }
// Returns: { success, executionId, instanceId, workflowId, workflowName, status }
// ---------------------------------------------------------------------------

type ExecuteBody = {
	workflowId?: string;
	workflowName?: string;
	/** SW 1.0: an object of trigger fields. Dynamic-script: ANY JSON value,
	 *  passed verbatim as the script's `args` global (absent = undefined). */
	triggerData?: unknown;
	/** Dynamic-script token budget (forwarded to the start path for script workflows). */
	budgetTotal?: number | null;
};

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as ExecuteBody;

	const budgetTotal =
		typeof body.budgetTotal === 'number' && Number.isFinite(body.budgetTotal)
			? body.budgetTotal
			: undefined;
	const result = await startWorkflowRun({
		workflowId: body.workflowId,
		workflowName: body.workflowName,
		// Verbatim: dynamic-script accepts any JSON value (undefined = no args);
		// the SW start path coerces non-objects to {} itself.
		triggerData: body.triggerData,
		...(budgetTotal !== undefined ? { budgetTotal } : {})
	});

	if (!result.ok) {
		if (result.status >= 500) {
			console.error('[internal/agent/workflows/execute] Failed:', result.error);
		}
		return json({ error: result.error }, { status: result.status });
	}

	return json({
		success: true,
		executionId: result.executionId,
		instanceId: result.instanceId,
		workflowId: result.workflowId,
		workflowName: result.workflowName,
		status: result.status
	});
};
