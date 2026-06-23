import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows, workflowTriggers } from '$lib/server/db/schema';
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
	if (!db) throw error(503, 'Database not configured');
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	const [wf] = await db
		.select({ id: workflows.id, projectId: workflows.projectId, userId: workflows.userId })
		.from(workflows)
		.where(eq(workflows.id, workflowId))
		.limit(1);
	if (!wf) throw error(404, 'Workflow not found');
	if (!isResourceInScope({ projectId: wf.projectId, userId: wf.userId }, locals.session)) {
		throw error(404, 'Workflow not found');
	}
	return wf;
}

// GET — list a workflow's triggers.
export const GET: RequestHandler = async ({ params, locals }) => {
	await scopedWorkflow(params.workflowId!, locals);
	const rows = await db!
		.select()
		.from(workflowTriggers)
		.where(eq(workflowTriggers.workflowId, params.workflowId!))
		.orderBy(desc(workflowTriggers.createdAt));
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

	const [row] = await db!
		.insert(workflowTriggers)
		.values({
			workflowId: wf.id,
			userId: locals.session!.userId,
			projectId: wf.projectId ?? null,
			kind: kind.id,
			config: body.config ?? {},
			triggerData: body.triggerData ?? null,
			dedupSalt: generateId(),
			status: 'inactive'
		})
		.returning();
	return json({ trigger: sanitizeTrigger(row) }, { status: 201 });
};
