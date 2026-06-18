/**
 * Workspace/project scoping for trace (observability) endpoints.
 *
 * Traces live in ClickHouse and aren't project-tagged there. We resolve a
 * trace's `session.id` / `workflow.execution.id` (span attributes) back to the
 * owning `sessions` / `workflow_executions` row and gate with the same
 * `isResourceInScope` contract used by the rest of the workflow APIs. A trace
 * with no resolvable owner row is treated as out-of-scope (404) so cross-tenant
 * traces aren't exposed.
 */
import { error } from '@sveltejs/kit';
import { inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { sessions, workflowExecutions } from '$lib/server/db/schema';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { queryClickHouse, CLICKHOUSE_DB } from '$lib/server/otel/clickhouse';

const chEscape = (s: string) => s.replace(/'/g, "''");

type CallerSession = { userId: string; projectId?: string | null };

/**
 * Resolve ALL session.id + workflow.execution.id values a trace touches.
 *
 * A single trace can carry several owners — e.g. a workflow trace spans the
 * (row-less) parent workflow session, the bridged child agent session, AND the
 * workflow execution. We must consider every candidate, not just one, or a
 * trace whose first-seen owner happens to be unscoped (the parent workflow
 * session has no `sessions` row) is wrongly rejected.
 */
export async function resolveTraceOwners(
	traceId: string,
): Promise<{ sessionIds: string[]; executionIds: string[] }> {
	const t = chEscape(traceId.trim());
	if (!t) return { sessionIds: [], executionIds: [] };
	const rows = await queryClickHouse(`
		SELECT
			arrayFilter(x -> x != '', groupUniqArray(SpanAttributes['session.id'])) AS SessionIds,
			arrayFilter(x -> x != '', groupUniqArray(SpanAttributes['workflow.execution.id'])) AS ExecutionIds
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE TraceId = '${t}'
	`);
	const row = rows[0] ?? {};
	return {
		sessionIds: (row.SessionIds as string[]) ?? [],
		executionIds: (row.ExecutionIds as string[]) ?? [],
	};
}

/**
 * Throw 404 unless the caller may view this trace. A trace is in scope when ANY
 * of its owning sessions OR workflow executions is in the caller's
 * workspace/ownership.
 */
export async function assertTraceInScope(
	traceId: string,
	session: CallerSession | null | undefined,
): Promise<void> {
	if (!session?.userId) throw error(401, 'Authentication required');
	if (!db) throw error(503, 'Database not configured');
	const { sessionIds, executionIds } = await resolveTraceOwners(traceId);

	if (sessionIds.length) {
		const rows = await db
			.select({ projectId: sessions.projectId, userId: sessions.userId })
			.from(sessions)
			.where(inArray(sessions.id, sessionIds));
		if (rows.some((row) => isResourceInScope(row, session))) return;
	}
	if (executionIds.length) {
		const rows = await db
			.select({ projectId: workflowExecutions.projectId, userId: workflowExecutions.userId })
			.from(workflowExecutions)
			.where(inArray(workflowExecutions.id, executionIds));
		if (rows.some((row) => isResourceInScope(row, session))) return;
	}
	throw error(404, 'Trace not found');
}
