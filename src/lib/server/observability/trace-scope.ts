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
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { sessions, workflowExecutions } from '$lib/server/db/schema';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { queryClickHouse, CLICKHOUSE_DB } from '$lib/server/otel/clickhouse';

const chEscape = (s: string) => s.replace(/'/g, "''");

type CallerSession = { userId: string; projectId?: string | null };

/** Resolve the session.id + workflow.execution.id a trace belongs to. */
export async function resolveTraceOwners(
	traceId: string,
): Promise<{ sessionId: string | null; executionId: string | null }> {
	const t = chEscape(traceId.trim());
	if (!t) return { sessionId: null, executionId: null };
	const rows = await queryClickHouse(`
		SELECT
			anyIf(SpanAttributes['session.id'], SpanAttributes['session.id'] != '') AS SessionId,
			anyIf(SpanAttributes['workflow.execution.id'], SpanAttributes['workflow.execution.id'] != '') AS ExecutionId
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE TraceId = '${t}'
	`);
	const row = rows[0] ?? {};
	return {
		sessionId: (row.SessionId as string) || null,
		executionId: (row.ExecutionId as string) || null,
	};
}

/**
 * Throw 404 unless the caller may view this trace. A trace is in scope when its
 * owning session OR workflow execution is in the caller's workspace/ownership.
 */
export async function assertTraceInScope(
	traceId: string,
	session: CallerSession | null | undefined,
): Promise<void> {
	if (!session?.userId) throw error(401, 'Authentication required');
	if (!db) throw error(503, 'Database not configured');
	const { sessionId, executionId } = await resolveTraceOwners(traceId);

	if (sessionId) {
		const [row] = await db
			.select({ projectId: sessions.projectId, userId: sessions.userId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		if (row && isResourceInScope(row, session)) return;
	}
	if (executionId) {
		const [row] = await db
			.select({ projectId: workflowExecutions.projectId, userId: workflowExecutions.userId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (row && isResourceInScope(row, session)) return;
	}
	throw error(404, 'Trace not found');
}
