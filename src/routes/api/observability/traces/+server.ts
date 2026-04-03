import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { queryClickHouse, CLICKHOUSE_DB } from '$lib/server/otel/clickhouse';

/**
 * GET /api/observability/traces?service=...&limit=...
 * Lists recent traces from ClickHouse OTEL traces table.
 */
export const GET: RequestHandler = async ({ url }) => {
	const service = url.searchParams.get('service') || '';
	const limit = parseInt(url.searchParams.get('limit') || '30');

	try {
		const serviceRows = await queryClickHouse(
			`SELECT DISTINCT ServiceName FROM ${CLICKHOUSE_DB}.otel_traces WHERE Timestamp > now() - INTERVAL 7 DAY ORDER BY ServiceName`
		);
		const services = serviceRows.map((r) => r.ServiceName as string);

		const whereClause = service
			? `WHERE ServiceName = '${service.replace(/'/g, "''")}' AND Timestamp > now() - INTERVAL 7 DAY`
			: 'WHERE Timestamp > now() - INTERVAL 7 DAY';

		const traceRows = await queryClickHouse(`
			SELECT
				TraceId,
				min(Timestamp) as StartTime,
				max(Duration)/1000000 as TotalDurationMs,
				count() as SpanCount,
				any(ServiceName) as RootService,
				any(SpanName) as RootOperation,
				anyIf(StatusCode, StatusCode = 'Error') as HasError
			FROM ${CLICKHOUSE_DB}.otel_traces
			${whereClause}
			GROUP BY TraceId
			ORDER BY StartTime DESC
			LIMIT ${limit}
		`);

		const traces = traceRows.map((r) => ({
			traceId: r.TraceId as string,
			serviceName: r.RootService as string,
			operationName: r.RootOperation as string,
			startTime: r.StartTime as string,
			duration: Math.round(r.TotalDurationMs as number),
			spanCount: r.SpanCount as number,
			status: (r.HasError as string) === 'Error' ? 'error' : ('ok' as const)
		}));

		return json({ traces, services });
	} catch (err) {
		return json({
			traces: [],
			services: [],
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};
