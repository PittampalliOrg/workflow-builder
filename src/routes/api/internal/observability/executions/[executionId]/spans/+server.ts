import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchTraceSpans } from '$lib/server/otel/clickhouse';
import { resolveTraceIdsForExecution } from '$lib/server/observability/run-digest-loader';
import { guardAnalystAccess } from '../guard';

/**
 * GET ?query=&errorsOnly=&limit= — search the run's connected spans by
 * substring over operation/service/status message + session id. Returns lean
 * rows (no attribute dumps) so the analyst's context stays small.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const query = (url.searchParams.get('query') ?? '').toLowerCase();
	const errorsOnly = url.searchParams.get('errorsOnly') === 'true';
	const limit = Math.min(100, Number(url.searchParams.get('limit')) || 40);

	const traceIds = await resolveTraceIdsForExecution(guard.execution);
	const spans = traceIds.length
		? await searchTraceSpans(traceIds, { query, errorsOnly, limit })
		: [];
	const rows = spans.map((s) => ({
			spanId: s.spanId,
			parentSpanId: s.parentSpanId,
			traceId: s.traceId,
			name: s.operationName,
			service: s.serviceName,
			startTime: s.startTime,
			durationMs: s.duration,
			status: s.statusCode ?? s.status,
			statusMessage: s.statusMessage ?? null,
			sessionId: s.attributes?.['session.id'] ?? null
		}));
	return json({ spans: rows, total: rows.length, limited: rows.length >= limit });
};
