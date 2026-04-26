import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflows } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { syncWorkflowConnectionRefs } from '$lib/server/workflow-connections';
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!db) return json([]);

	const limit = parseInt(url.searchParams.get('limit') || '50');
	const projectOnly = url.searchParams.get('projectOnly') === '1';
	if (projectOnly && !locals.session?.projectId) return json([]);
	let query = db
		.select({
			id: workflows.id,
			name: workflows.name,
			engineType: workflows.engineType,
			createdAt: workflows.createdAt,
			updatedAt: workflows.updatedAt
		})
		.from(workflows)
		.$dynamic();
	if (projectOnly && locals.session?.projectId) {
		query = query.where(eq(workflows.projectId, locals.session.projectId));
	}
	const result = await query.orderBy(desc(workflows.updatedAt)).limit(limit);

	return json(result);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!locals.session.projectId)
		return error(400, 'No active workspace — cannot create workflow');

	const body = await request.json();

	const [workflow] = await db
		.insert(workflows)
		.values({
			name: body.name || 'Untitled Workflow',
			nodes: body.nodes || [],
			edges: body.edges || [],
			engineType: body.engineType || 'dapr',
			userId: locals.session.userId,
			projectId: locals.session.projectId
		})
		.returning();

	await syncWorkflowConnectionRefs(workflow.id, body.nodes || [], body.spec);

	return json(workflow, { status: 201 });
};
