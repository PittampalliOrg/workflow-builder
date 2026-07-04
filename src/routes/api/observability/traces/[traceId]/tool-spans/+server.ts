import { json, type RequestHandler } from '@sveltejs/kit';
import { normalizeRawTraceSpans } from '$lib/server/observability/trace-span-normalization';
import { getTraceSpans, getTraceToolSpans } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	await assertTraceInScope(params.traceId ?? '', locals.session);
	try {
		const traceId = params.traceId ?? '';
		let spans = await getTraceToolSpans(traceId);
		let source: 'derived' | 'raw-fallback' = 'derived';
		if (spans.length === 0) {
			const rawSpans = await getTraceSpans(traceId);
			spans = normalizeRawTraceSpans(rawSpans).toolSpans;
			source = spans.length > 0 ? 'raw-fallback' : 'derived';
		}
		return json({
			traceId,
			spans,
			spanCount: spans.length,
			source
		});
	} catch (err) {
		return json({
			traceId: params.traceId ?? '',
			spans: [],
			spanCount: 0,
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};
