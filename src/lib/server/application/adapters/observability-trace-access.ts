import {
	CLICKHOUSE_DB,
	getTraceSpanDetail,
	isClickHouseConfigured,
	queryClickHouse,
} from "$lib/server/otel/clickhouse";
import type {
	ObservabilityTraceOwnerResolver,
	ObservabilityTraceOwners,
	ObservabilityTraceSpanDetailReader,
} from "$lib/server/application/observability-trace-access";

const chEscape = (value: string) => value.replace(/'/g, "''");

export class ClickHouseTraceOwnerResolver
	implements ObservabilityTraceOwnerResolver
{
	async resolveTraceOwners(traceId: string): Promise<ObservabilityTraceOwners> {
		const id = chEscape(traceId.trim());
		if (!id) return { sessionIds: [], executionIds: [] };
		const rows = await queryClickHouse(`
			SELECT
				arrayFilter(x -> x != '', groupUniqArray(SpanAttributes['session.id'])) AS SessionIds,
				arrayFilter(x -> x != '', groupUniqArray(SpanAttributes['workflow.execution.id'])) AS ExecutionIds
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE TraceId = '${id}'
		`);
		const row = rows[0] ?? {};
		return {
			sessionIds: (row.SessionIds as string[]) ?? [],
			executionIds: (row.ExecutionIds as string[]) ?? [],
		};
	}
}

export class ClickHouseTraceSpanDetailReader
	implements ObservabilityTraceSpanDetailReader
{
	isConfigured(): boolean {
		return isClickHouseConfigured();
	}

	getSpanDetail(traceId: string, spanId: string): Promise<unknown | null> {
		return getTraceSpanDetail(traceId, spanId);
	}
}
