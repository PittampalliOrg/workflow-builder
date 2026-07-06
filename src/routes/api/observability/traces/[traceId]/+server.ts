import { json, error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { queryClickHouse, CLICKHOUSE_DB, isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from './trace-access';

/**
 * GET /api/observability/traces/[traceId]
 * Returns all spans for a trace from ClickHouse.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { traceId } = params;
	// No ClickHouse (e.g. a vcluster preview): degrade to 503 rather than 500 from
	// the access check / query hitting a non-existent host.
	if (!isClickHouseConfigured()) {
		return json(
			{ configured: false, traceId, spans: [], totalDuration: 0, startTime: '', spanCount: 0, services: [] },
			{ status: 503 }
		);
	}
	try {
		// Scope check queries ClickHouse too, so it lives INSIDE the try — an
		// unreachable-but-configured ClickHouse (central host, no route from a
		// vcluster) throws a transport error here that must degrade to 503, while a
		// deliberate scope rejection (HttpError 403/404) still propagates.
		await assertTraceInScope(traceId, locals.session);

		const rows = await queryClickHouse(`
			SELECT
				TraceId,
				SpanId,
				ParentSpanId,
				SpanName,
				SpanKind,
				ServiceName,
				Duration/1000000 as DurationMs,
				StatusCode,
				StatusMessage,
				Timestamp,
				SpanAttributes,
				ResourceAttributes
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE TraceId = '${traceId.replace(/'/g, "''")}'
			ORDER BY Timestamp ASC
		`);

		if (rows.length === 0) {
			return error(404, 'Trace not found');
		}

		// Build span tree
		const spans = rows.map((r) => ({
			traceId: r.TraceId as string,
			spanId: r.SpanId as string,
			parentSpanId: r.ParentSpanId as string,
			operationName: r.SpanName as string,
			serviceName: r.ServiceName as string,
			duration: Math.round(r.DurationMs as number),
			statusCode: r.StatusCode as string,
			statusMessage: r.StatusMessage as string,
			startTime: r.Timestamp as string,
			spanKind: r.SpanKind as string,
			attributes: r.SpanAttributes as Record<string, string>,
			resourceAttributes: r.ResourceAttributes as Record<string, string>
		}));

		// Compute total duration and depth
		const totalDuration = Math.max(...spans.map((s) => s.duration), 0);
		const startTime = spans[0]?.startTime || '';

		// Build depth by parent chain
		const spanMap = new Map(spans.map((s) => [s.spanId, s]));
		const depths = new Map<string, number>();

		function getDepth(spanId: string): number {
			if (depths.has(spanId)) return depths.get(spanId)!;
			const span = spanMap.get(spanId);
			if (!span || !span.parentSpanId || !spanMap.has(span.parentSpanId)) {
				depths.set(spanId, 0);
				return 0;
			}
			const d = getDepth(span.parentSpanId) + 1;
			depths.set(spanId, d);
			return d;
		}

		const enrichedSpans = spans.map((s) => ({
			...s,
			depth: getDepth(s.spanId)
		}));

		// Unique services
		const serviceNames = [...new Set(spans.map((s) => s.serviceName))];

		return json({
			traceId,
			spans: enrichedSpans,
			totalDuration,
			startTime,
			spanCount: spans.length,
			services: serviceNames
		});
	} catch (err) {
		// Deliberate scope rejection (403/404) or the "Trace not found" 404 above —
		// let SvelteKit render it unchanged.
		if (isHttpError(err)) throw err;
		// ClickHouse transport/query failure → soft 503 (not a 500 that trips the UI).
		return json(
			{
				configured: true,
				available: false,
				traceId,
				spans: [],
				totalDuration: 0,
				startTime: '',
				spanCount: 0,
				services: [],
				error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 503 }
		);
	}
};
