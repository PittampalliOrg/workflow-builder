import { json, type RequestHandler } from '@sveltejs/kit';
import {
	enrichLlmSpansWithRawTraceAttributes,
	normalizeRawTraceSpans
} from '$lib/server/observability/trace-span-normalization';
import { getTraceLlmSpans, getTraceSpans, isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!isClickHouseConfigured()) {
		return json({ configured: false, traceId: params.traceId ?? '', spans: [], spanCount: 0 }, { status: 503 });
	}
	await assertTraceInScope(params.traceId ?? '', locals.session);
	try {
		const traceId = params.traceId ?? '';
		let spans = await getTraceLlmSpans(traceId);
		let source: 'derived' | 'raw-fallback' = 'derived';
		const rawSpans = await getTraceSpans(traceId);
		if (spans.length === 0) {
			spans = normalizeRawTraceSpans(rawSpans).llmSpans;
			source = spans.length > 0 ? 'raw-fallback' : 'derived';
		} else {
			spans = enrichLlmSpansWithRawTraceAttributes(spans, rawSpans);
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
