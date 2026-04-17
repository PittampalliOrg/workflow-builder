import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { sessions, workflowExecutions, workflows } from '$lib/server/db/schema';
import { desc, eq, inArray, sql } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params }) => {
	if (!db) return json([]);

	const sandboxName = params.name;
	let executionIds: string[] | null = null;

	// Phase 4 Step 2b: sessions carry the runtime label on `sandbox_name`, so
	// every `durable/run` execution that spawned a session for this runtime is
	// reachable via the sessions join. `workflow_agent_events` was the old
	// source for this lookup and is gone.
	if (sandboxName === 'dapr-agent-py' || sandboxName === 'dapr-agent-py-testing') {
		const sessionRows = await db
			.select({ workflowExecutionId: sessions.workflowExecutionId })
			.from(sessions)
			.where(
				sql`${sessions.sandboxName} = ${sandboxName} AND ${sessions.workflowExecutionId} IS NOT NULL`
			)
			.orderBy(desc(sessions.createdAt))
			.limit(50);
		executionIds = [
			...new Set(
				sessionRows
					.map((row) => row.workflowExecutionId)
					.filter((id): id is string => typeof id === 'string' && id.length > 0)
			)
		].slice(0, 10);
		if (executionIds.length === 0) return json([]);
	}

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
		.where(
			executionIds && executionIds.length > 0
				? inArray(workflowExecutions.id, executionIds)
				: sql`${workflowExecutions.output}::text LIKE ${'%' + sandboxName + '%'}`
		)
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
