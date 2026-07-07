import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMultiTraceLogs, isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { loadExecutionTraceBundle } from '$lib/server/observability/run-digest-loader';
import { guardAnalystAccess } from '../guard';

/** GET ?spanId=&errorsOnly=&limit= — correlated logs for the run (optionally one span). */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	if (!isClickHouseConfigured()) return json({ logs: [] });
	const spanId = url.searchParams.get('spanId');
	const errorsOnly = url.searchParams.get('errorsOnly') === 'true';
	const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);

	const { traceIds } = await loadExecutionTraceBundle(guard.execution);
	if (traceIds.length === 0) return json({ logs: [] });
	const logs = await getMultiTraceLogs(traceIds);
	const rows = logs
		.filter((l) => (spanId ? l.spanId === spanId : true))
		.filter((l) => (errorsOnly ? /error|fatal/i.test(l.severityText ?? '') : true))
		.slice(0, limit)
		.map((l) => ({
			timestamp: l.timestamp,
			spanId: l.spanId,
			service: l.serviceName,
			severity: l.severityText,
			body: typeof l.body === 'string' ? l.body.slice(0, 500) : l.body
		}));
	return json({ logs: rows });
};
