import { json, type RequestHandler } from '@sveltejs/kit';
import { getSessionToolSpans } from '$lib/server/otel/clickhouse';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const sessionId = params.sessionId ?? '';
		const spans = await getSessionToolSpans(sessionId);
		return json({
			sessionId,
			spans,
			spanCount: spans.length
		});
	} catch (err) {
		return json({
			sessionId: params.sessionId ?? '',
			spans: [],
			spanCount: 0,
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};
