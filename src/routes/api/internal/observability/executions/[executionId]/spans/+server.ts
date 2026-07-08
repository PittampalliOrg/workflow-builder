import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadExecutionTraceBundle } from '$lib/server/observability/run-digest-loader';
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

	const { spans } = await loadExecutionTraceBundle(guard.execution);
	const rows = spans
		.filter((s) => {
			if (errorsOnly && s.status !== 'error' && s.statusCode !== 'Error') return false;
			if (!query) return true;
			const hay =
				`${s.operationName} ${s.serviceName} ${s.statusMessage ?? ''} ${s.attributes?.['session.id'] ?? ''}`.toLowerCase();
			return hay.includes(query);
		})
		.slice(0, limit)
		.map((s) => ({
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
	return json({ spans: rows, total: spans.length });
};
