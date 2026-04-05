import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflows } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { syncWorkflowConnectionRefs } from '$lib/server/workflow-connections';
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!db) return json([]);

	const limit = parseInt(url.searchParams.get('limit') || '50');
	const result = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			engineType: workflows.engineType,
			createdAt: workflows.createdAt,
			updatedAt: workflows.updatedAt
		})
		.from(workflows)
		.orderBy(desc(workflows.updatedAt))
		.limit(limit);

	return json(result);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!db) return error(503, 'Database not configured');

	const body = await request.json();
	const userId = locals.session?.userId || 'system';

	const [workflow] = await db
		.insert(workflows)
		.values({
			name: body.name || 'Untitled Workflow',
			nodes: body.nodes || [],
			edges: body.edges || [],
			engineType: body.engineType || 'dapr',
			userId
		})
		.returning();

	await syncWorkflowConnectionRefs(workflow.id, body.nodes || []);

	return json(workflow, { status: 201 });
};
