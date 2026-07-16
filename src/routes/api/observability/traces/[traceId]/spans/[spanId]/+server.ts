import { error, isHttpError, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getTraceSpanDetail,
	isClickHouseConfigured
} from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../../trace-access';

/**
 * GET /api/observability/traces/[traceId]/spans/[spanId]
 * Returns the complete attribute payload for one authorized span.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { traceId, spanId } = params;

	if (!isClickHouseConfigured()) {
		return json(
			{ configured: false, available: false, traceId, spanId, span: null },
			{ status: 503 }
		);
	}

	try {
		await assertTraceInScope(traceId, locals.session);

		const span = await getTraceSpanDetail(traceId, spanId);
		if (!span) throw error(404, 'Span not found');

		return json({ configured: true, available: true, traceId, spanId, span });
	} catch (err) {
		if (isHttpError(err)) throw err;

		return json(
			{
				configured: true,
				available: false,
				traceId,
				spanId,
				span: null,
				error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 503 }
		);
	}
};
