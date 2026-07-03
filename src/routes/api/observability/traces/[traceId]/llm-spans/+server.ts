import { json, type RequestHandler } from '@sveltejs/kit';
import {
	enrichLlmSpansWithRawTraceAttributes,
	normalizeRawTraceSpans
} from '$lib/server/benchmarks/trace-bundle';
import { getTraceLlmSpans, getTraceSpans } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
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
