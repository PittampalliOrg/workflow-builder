import { json, type RequestHandler } from '@sveltejs/kit';
import { getTraceToolSpans } from '$lib/server/otel/clickhouse';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const traceId = params.traceId ?? '';
		const spans = await getTraceToolSpans(traceId);
		return json({
			traceId,
			spans,
			spanCount: spans.length
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
