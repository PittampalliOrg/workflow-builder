import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { sessions, workflowExecutions } from '$lib/server/db/schema';
import { queryClickHouse, CLICKHOUSE_DB } from '$lib/server/otel/clickhouse';

const chEscape = (s: string) => s.replace(/'/g, "''");
const inList = (ids: string[]) => ids.map((id) => `'${chEscape(id)}'`).join(', ');

const TIME_RANGES: Record<string, string> = {
	'1h': '1 HOUR',
	'6h': '6 HOUR',
	'24h': '24 HOUR',
	'7d': '7 DAY',
};

/**
 * GET /api/observability/traces — recent traces from ClickHouse, SCOPED to the
 * caller's workspace (project) by resolving each trace's session.id /
 * workflow.execution.id against the in-scope sessions + executions.
 *
 * Query params: service, status(ok|error), search, range(1h|6h|24h|7d),
 *   sessionId (deep-link from a session; must be in scope), limit.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const userId = locals.session.userId;
	const projectId = locals.session.projectId ?? null;
	const service = url.searchParams.get('service') || '';
	const status = url.searchParams.get('status') || '';
	const search = (url.searchParams.get('search') || '').trim();
	const range = url.searchParams.get('range') || '7d';
	const sessionIdFilter = url.searchParams.get('sessionId') || '';
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
	const interval = TIME_RANGES[range] ?? TIME_RANGES['7d'];

	try {
		// Resolve the in-scope id sets (CMA: workspace match; else owner fallback).
		const scopeWhere = projectId
			? or(eq(sessions.projectId, projectId), and(isNull(sessions.projectId), eq(sessions.userId, userId)))
			: eq(sessions.userId, userId);
		const execScopeWhere = projectId
			? or(
					eq(workflowExecutions.projectId, projectId),
					and(isNull(workflowExecutions.projectId), eq(workflowExecutions.userId, userId)),
				)
			: eq(workflowExecutions.userId, userId);

		const sessionRows = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(scopeWhere)
			.orderBy(desc(sessions.createdAt))
			.limit(1000);
		const execRows = await db
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(execScopeWhere)
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(1000);

		const inScopeSessionIds = new Set(sessionRows.map((r) => r.id));
		const sessionIds = sessionRows.map((r) => r.id);
		const execIds = execRows.map((r) => r.id);

		// Deep-link: a specific session must be in the caller's scope.
		if (sessionIdFilter && !inScopeSessionIds.has(sessionIdFilter)) {
			return error(404, 'Session not found');
		}

		if (sessionIds.length === 0 && execIds.length === 0) {
			return json({ traces: [], services: [] });
		}

		// Scope predicate: spans whose session.id / workflow.execution.id is in scope.
		const scopeIdClauses: string[] = [];
		if (sessionIdFilter) {
			const s = chEscape(sessionIdFilter);
			scopeIdClauses.push(`SpanAttributes['session.id'] = '${s}'`);
		} else {
			if (sessionIds.length)
				scopeIdClauses.push(`SpanAttributes['session.id'] IN (${inList(sessionIds)})`);
			if (execIds.length)
				scopeIdClauses.push(`SpanAttributes['workflow.execution.id'] IN (${inList(execIds)})`);
		}
		const scopeClause = `(${scopeIdClauses.join(' OR ')})`;

		const clauses = [
			`Timestamp > now() - INTERVAL ${interval}`,
			`TraceId IN (SELECT DISTINCT TraceId FROM ${CLICKHOUSE_DB}.otel_traces WHERE Timestamp > now() - INTERVAL ${interval} AND ${scopeClause})`,
		];
		if (service) clauses.push(`ServiceName = '${chEscape(service)}'`);
		if (search) {
			const q = chEscape(search);
			clauses.push(
				`(positionCaseInsensitive(TraceId, '${q}') > 0 OR positionCaseInsensitive(SpanName, '${q}') > 0 OR positionCaseInsensitive(SpanAttributes['session.id'], '${q}') > 0)`,
			);
		}
		const whereClause = `WHERE ${clauses.join(' AND ')}`;
		const havingClause = status === 'error' ? 'HAVING HasError = 1' : status === 'ok' ? 'HAVING HasError = 0' : '';

		const traceRows = await queryClickHouse(`
			SELECT
				TraceId,
				min(Timestamp) AS StartTime,
				(max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp))) / 1e6 AS DurationMs,
				count() AS SpanCount,
				coalesce(nullIf(anyIf(SpanName, ParentSpanId = ''), ''), argMin(SpanName, Timestamp)) AS RootOperation,
				coalesce(nullIf(anyIf(ServiceName, ParentSpanId = ''), ''), argMin(ServiceName, Timestamp)) AS RootService,
				arraySlice(arraySort(groupUniqArray(ServiceName)), 1, 12) AS Services,
				countIf(SpanAttributes['openinference.span.kind'] = 'LLM') AS LlmCount,
				countIf(SpanAttributes['openinference.span.kind'] = 'TOOL' AND SpanAttributes['tool.name'] != '') AS ToolCount,
				sum(toUInt64OrZero(SpanAttributes['llm.token_count.total'])) AS TotalTokens,
				maxIf(1, StatusCode = 'Error') AS HasError
			FROM ${CLICKHOUSE_DB}.otel_traces
			${whereClause}
			GROUP BY TraceId
			${havingClause}
			ORDER BY StartTime DESC
			LIMIT ${limit}
		`);

		const traces = traceRows.map((r) => ({
			traceId: r.TraceId as string,
			rootOperation: r.RootOperation as string,
			rootService: r.RootService as string,
			services: (r.Services as string[]) ?? [],
			startTime: r.StartTime as string,
			duration: Math.round(Number(r.DurationMs) || 0),
			spanCount: Number(r.SpanCount) || 0,
			llmCount: Number(r.LlmCount) || 0,
			toolCount: Number(r.ToolCount) || 0,
			totalTokens: Number(r.TotalTokens) || 0,
			status: (r.HasError as number) === 1 ? ('error' as const) : ('ok' as const),
		}));

		// Distinct services for the filter dropdown (within the time range).
		const serviceRows = await queryClickHouse(
			`SELECT DISTINCT ServiceName FROM ${CLICKHOUSE_DB}.otel_traces WHERE Timestamp > now() - INTERVAL ${interval} ORDER BY ServiceName`,
		);
		const services = serviceRows.map((r) => r.ServiceName as string);

		return json({ traces, services });
	} catch (err) {
		return json({
			traces: [],
			services: [],
			error: `Failed to query traces: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
};
