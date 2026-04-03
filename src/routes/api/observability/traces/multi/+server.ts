import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { queryClickHouse, CLICKHOUSE_DB } from '$lib/server/otel/clickhouse';

/**
 * POST /api/observability/traces/multi
 * Accepts { traceIds: string[] } and returns merged spans from all traces.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const traceIds: string[] = Array.isArray(body.traceIds) ? body.traceIds : [];

	if (traceIds.length === 0) {
		return json({ spans: [], totalDuration: 0, spanCount: 0, services: [], traceIds: [] });
	}

	// Sanitize trace IDs
	const sanitized = traceIds
		.filter((id) => typeof id === 'string' && /^[a-f0-9]+$/i.test(id.trim()))
		.map((id) => id.trim());

	if (sanitized.length === 0) {
		return json({ spans: [], totalDuration: 0, spanCount: 0, services: [], traceIds: [] });
	}

	try {
		const inClause = sanitized.map((id) => `'${id}'`).join(', ');

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
			WHERE TraceId IN (${inClause})
			ORDER BY Timestamp ASC
		`);

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
			resourceAttributes: r.ResourceAttributes as Record<string, string>,
			status: (r.StatusCode as string) === 'STATUS_CODE_ERROR' ? 'error' : 'ok'
		}));

		// Compute depth per span within each trace
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

		const totalDuration = Math.max(...spans.map((s) => s.duration), 0);
		const services = [...new Set(spans.map((s) => s.serviceName))];
		const foundTraceIds = [...new Set(spans.map((s) => s.traceId))];

		return json({
			spans: enrichedSpans,
			totalDuration,
			spanCount: spans.length,
			services,
			traceIds: foundTraceIds
		});
	} catch (err) {
		return json({
			spans: [],
			totalDuration: 0,
			spanCount: 0,
			services: [],
			traceIds: [],
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};
