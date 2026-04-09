import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { desc, sql, eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params }) => {
	if (!db) return json([]);

	const sandboxName = params.name;

	const rows = await db
		.select({
			id: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			status: workflowExecutions.status,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt
		})
		.from(workflowExecutions)
		.leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
		.where(sql`${workflowExecutions.output}::text LIKE ${'%' + sandboxName + '%'}`)
		.orderBy(desc(workflowExecutions.startedAt))
		.limit(10);

	return json(
		rows.map((r) => ({
			executionId: r.id,
			workflowId: r.workflowId,
			workflowName: r.workflowName ?? 'Unknown',
			status: r.status,
			startedAt: r.startedAt?.toISOString() ?? null,
			completedAt: r.completedAt?.toISOString() ?? null
		}))
	);
};
