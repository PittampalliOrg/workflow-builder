import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowAgentEvents, workflowExecutions, workflows } from '$lib/server/db/schema';
import { desc, sql, eq, inArray } from 'drizzle-orm';

export const GET: RequestHandler = async ({ params }) => {
	if (!db) return json([]);

	const sandboxName = params.name;
	let executionIds: string[] | null = null;

	if (sandboxName === 'dapr-agent-py' || sandboxName === 'dapr-agent-py-testing') {
		const eventRows = await db
			.select({ workflowExecutionId: workflowAgentEvents.workflowExecutionId })
			.from(workflowAgentEvents)
			.where(
				sql`(
					${workflowAgentEvents.sandboxName} = ${sandboxName}
					OR ${workflowAgentEvents.payload}->>'source' = ${sandboxName}
					OR ${workflowAgentEvents.payload}->>'sandboxName' = ${sandboxName}
					OR ${workflowAgentEvents.payload}->>'agentRuntime' = ${sandboxName}
					OR ${workflowAgentEvents.payload}->>'runtime' = ${sandboxName}
				)`
			)
			.orderBy(desc(workflowAgentEvents.eventId))
			.limit(50);
		executionIds = [...new Set(eventRows.map((row) => row.workflowExecutionId))].slice(0, 10);
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
