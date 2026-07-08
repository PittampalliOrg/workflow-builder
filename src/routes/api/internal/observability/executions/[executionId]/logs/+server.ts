import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchTraceLogs, isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { resolveTraceIdsForExecution } from '$lib/server/observability/run-digest-loader';
import { guardAnalystAccess } from '../guard';

/** GET ?spanId=&errorsOnly=&limit= — correlated logs for the run (optionally one span). */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	if (!isClickHouseConfigured()) return json({ logs: [] });
	const spanId = url.searchParams.get('spanId');
	const errorsOnly = url.searchParams.get('errorsOnly') === 'true';
	const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);

	// Trace ids only (no full-bundle fetch), then push SpanId/errorsOnly/LIMIT
	// into ClickHouse so a huge trace can't ship all its log rows over the
	// dev->hub egress and keep the MCP SSE stream open indefinitely.
	const traceIds = await resolveTraceIdsForExecution(guard.execution);
	if (traceIds.length === 0) return json({ logs: [] });
	const logs = await searchTraceLogs(traceIds, {
		spanId: spanId ?? undefined,
		errorsOnly,
		limit
	});
	const rows = logs.map((l) => ({
		timestamp: l.timestamp,
		spanId: l.spanId,
		service: l.serviceName,
		severity: l.severityText,
		body: typeof l.body === 'string' ? l.body.slice(0, 500) : l.body
	}));
	return json({ logs: rows, total: rows.length, limited: rows.length >= limit });
};
