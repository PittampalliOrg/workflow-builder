import { error } from '@sveltejs/kit';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';

export type ServiceGraphExecOption = { id: string; label: string; workflowId: string | null };
export type ServiceGraphWorkflowOption = { id: string; name: string };

/**
 * Cheap initial load for the service-graph page: the recent executions and
 * workflows that populate the selectors, plus a default execution to focus.
 * The graph itself is fetched client-side from /api/observability/service-graph
 * so toggles re-fetch without a full navigation.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!db) throw error(503, 'Database not configured');
	if (!locals.session?.userId) throw error(401, 'Authentication required');

	const projectId = locals.session.projectId ?? null;
	const scopeWorkflows = projectId
		? or(
				eq(workflows.projectId, projectId),
				and(isNull(workflows.projectId), eq(workflows.userId, locals.session.userId))
			)
		: eq(workflows.userId, locals.session.userId);
	const scopeExecutions = projectId
		? or(
				eq(workflowExecutions.projectId, projectId),
				and(
					isNull(workflowExecutions.projectId),
					eq(workflowExecutions.userId, locals.session.userId)
				)
			)
		: eq(workflowExecutions.userId, locals.session.userId);

	const [wfRows, exRows] = await Promise.all([
		db
			.select({ id: workflows.id, name: workflows.name })
			.from(workflows)
			.where(scopeWorkflows)
			.orderBy(desc(workflows.updatedAt))
			.limit(200),
		db
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				workflowId: workflowExecutions.workflowId
			})
			.from(workflowExecutions)
			.where(scopeExecutions)
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(50)
	]);

	const workflowName = new Map(wfRows.map((w) => [w.id, w.name]));
	const executions: ServiceGraphExecOption[] = exRows.map((e) => {
		const when = e.startedAt.toISOString().slice(5, 16).replace('T', ' ');
		const wf = e.workflowId ? (workflowName.get(e.workflowId) ?? 'workflow') : 'workflow';
		return {
			id: e.id,
			label: `${wf} · ${e.status} · ${when}`,
			workflowId: e.workflowId ?? null
		};
	});

	return {
		slug: params.slug,
		workflows: wfRows as ServiceGraphWorkflowOption[],
		executions,
		defaultExecutionId: executions[0]?.id ?? ''
	};
};
