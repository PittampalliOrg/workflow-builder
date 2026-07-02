import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowDefinition } from '$lib/server/application/ports';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { getTriggerKind, validateTriggerConfig } from '$lib/server/workflows/trigger-registry';
import { generateId } from '$lib/server/utils/id';

/** Strip reserved (`__`-prefixed) config keys (e.g. the encrypted HMAC secret)
 *  before returning a trigger row to the client. */
function sanitizeTrigger<T extends { config?: Record<string, unknown> | null }>(row: T): T {
	if (!row.config || typeof row.config !== 'object') return row;
	const clean: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row.config)) {
		if (!k.startsWith('__')) clean[k] = v;
	}
	return { ...row, config: clean };
}

async function scopedWorkflow(workflowId: string, locals: App.Locals) {
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	const wf = await getApplicationAdapters().workflowData.getWorkflowByRef({
		workflowId,
		lookup: 'id'
	});
	if (!wf) throw error(404, 'Workflow not found');
	if (!isResourceInScope(wf, locals.session)) {
		throw error(404, 'Workflow not found');
	}
	return wf;
}

// GET — list a workflow's triggers.
export const GET: RequestHandler = async ({ params, locals }) => {
	await scopedWorkflow(params.workflowId!, locals);
	const rows = await getApplicationAdapters().workflowData.listWorkflowTriggers(params.workflowId!);
	return json({ triggers: rows.map(sanitizeTrigger) });
};

// POST — create a trigger (inactive). Activate separately via …/[id]/activate.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const wf = await scopedWorkflow(params.workflowId!, locals);
	const body = (await request.json().catch(() => ({}))) as {
		kind?: string;
		config?: Record<string, unknown>;
		triggerData?: Record<string, unknown>;
	};
	const kind = getTriggerKind(body.kind);
	if (!kind) return error(400, `Unknown trigger kind: ${body.kind}`);
	const v = validateTriggerConfig(kind.id, body.config);
	if (!v.ok) return error(400, `Missing required config: ${v.missing.join(', ')}`);

	const row = await getApplicationAdapters().workflowData.createWorkflowTrigger({
		workflowId: (wf as WorkflowDefinition).id,
		userId: locals.session!.userId,
		projectId: wf.projectId ?? null,
		kind: kind.id,
		config: body.config ?? {},
		triggerData: body.triggerData ?? null,
		dedupSalt: generateId(),
		status: 'inactive'
	});
	return json({ trigger: sanitizeTrigger(row) }, { status: 201 });
};
