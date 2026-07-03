import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	CLICKHOUSE_DB,
	escapeClickHouseString,
	queryClickHouse,
} from "$lib/server/otel/clickhouse";
import {
	queryHistogramPercentiles,
	queryTimeSeries,
	type TimeSeriesPoint,
} from "$lib/server/otel/metrics";
import { fetchCapacityObserverSnapshot } from "$lib/server/capacity/observer";
import { buildCapacityBusinessWork } from "$lib/server/capacity/business-work";
import { enrichCapacitySnapshotOwnership } from "$lib/server/capacity/ownership";
import { setSpanValue } from "$lib/server/observability/content";
import type {
	CapacityBusinessWorkSummary,
	CapacityObserverResult,
	CapacityObserverSnapshot,
} from "$lib/types/capacity";
import type {
	CapacityBusinessWorkPort,
	CapacityMetricsPort,
	CapacityObserverPort,
	CapacityOverviewContext,
	CapacityOwnerTimeline,
	CapacityOwnerTimelinePoint,
	CapacityOwnershipPort,
	CapacityPsiTrendPoint,
	CapacityPsiTrendsSnapshot,
	CapacityTelemetryPort,
	CapacityTrendsSnapshot,
	SchedulingLatencySnapshot,
} from "$lib/server/application/capacity-overview";

const WINDOW_SECONDS = 300;
const BUCKET_SECONDS = 30;
const TRENDS_WINDOW_SECONDS = 3600;
const TRENDS_BUCKET_SECONDS = 30;
const OWNER_TIMELINE_TOP_N = 8;

export class HttpCapacityObserverAdapter implements CapacityObserverPort {
	fetchSnapshot(): Promise<CapacityObserverResult> {
		return fetchCapacityObserverSnapshot();
	}
}

export class LegacyCapacityOwnershipAdapter implements CapacityOwnershipPort {
	enrich(
		snapshot: CapacityObserverSnapshot,
		context: CapacityOverviewContext,
	): Promise<CapacityObserverSnapshot> {
		return enrichCapacitySnapshotOwnership(snapshot, context);
	}
}

export class LegacyCapacityBusinessWorkAdapter implements CapacityBusinessWorkPort {
	build(
		snapshot: CapacityObserverSnapshot,
		context: CapacityOverviewContext,
	): Promise<CapacityBusinessWorkSummary> {
		return buildCapacityBusinessWork(snapshot, context);
	}
}

export class OtelCapacityRemoteTelemetryAdapter implements CapacityTelemetryPort {
	private readonly tracer = trace.getTracer("workflow-builder.capacity-remote");

	async trace<T>(
		name: string,
		payload: unknown,
		fn: () => Promise<T>,
	): Promise<T> {
		const parentSpan = trace.getActiveSpan();
		const input = { remoteCall: name, payload };
		setSpanValue(parentSpan, "input", input);

		return this.tracer.startActiveSpan(
			`workflow-builder.remote ${name}`,
			async (span) => {
				span.setAttribute("workflow_builder.remote.name", name);
				setSpanValue(span, "input", input);
				try {
					const output = await fn();
					setSpanValue(span, "output", output);
					setSpanValue(parentSpan, "output", output);
					return output;
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					const output = { ok: false, error: err.message, remoteCall: name };
					setSpanValue(span, "output", output);
					setSpanValue(parentSpan, "output", output);
					span.recordException(err);
					span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
					throw error;
				} finally {
					span.end();
				}
			},
		);
	}
}

export class ClickHouseCapacityMetricsAdapter implements CapacityMetricsPort {
	async getSchedulingLatency(cluster: string): Promise<SchedulingLatencySnapshot> {
		const to = new Date();
		const from = new Date(to.getTime() - WINDOW_SECONDS * 1000);
		const filters = { cluster };
		try {
			const [percentiles, series] = await Promise.all([
				queryHistogramPercentiles(
					"dapr_runtime_workflow_scheduling_latency",
					[0.5, 0.95],
					{ from, to },
					filters,
				),
				queryTimeSeries(
					"dapr_runtime_workflow_scheduling_latency",
					BUCKET_SECONDS,
					{ from, to },
					filters,
					"avg",
				),
			]);
			const sparkline = series.map((point) => ({
				t: point.t.toISOString(),
				valueMs: point.value * 1000,
			}));
			return {
				cluster,
				windowSeconds: WINDOW_SECONDS,
				p50Ms:
					percentiles.count > 0 ? percentiles.percentiles.p50 * 1000 : null,
				p95Ms:
					percentiles.count > 0 ? percentiles.percentiles.p95 * 1000 : null,
				samples: percentiles.count,
				sparkline,
				hasData: percentiles.count > 0,
			};
		} catch {
			return {
				cluster,
				windowSeconds: WINDOW_SECONDS,
				p50Ms: null,
				p95Ms: null,
				samples: 0,
				sparkline: [],
				hasData: false,
			};
		}
	}

	async getPsiTrends(cluster: string): Promise<CapacityPsiTrendsSnapshot> {
		const to = new Date();
		const from = new Date(to.getTime() - WINDOW_SECONDS * 1000);
		const filters = { cluster };
		const empty = {
			cluster,
			windowSeconds: WINDOW_SECONDS,
			bucketSeconds: BUCKET_SECONDS,
			source: "unavailable" as const,
			cpuSomeAvg60Pct: [],
			memorySomeAvg60Pct: [],
			ioSomeAvg60Pct: [],
			coverageRatioPct: [],
			hasData: false,
		};
		try {
			const [cpu, memory, io, coverage] = await Promise.all([
				queryTimeSeries(
					"capacity_observer_psi_some_avg60_pct",
					BUCKET_SECONDS,
					{ from, to },
					{ ...filters, attribute: { resource: "cpu" } },
					"max",
				),
				queryTimeSeries(
					"capacity_observer_psi_some_avg60_pct",
					BUCKET_SECONDS,
					{ from, to },
					{ ...filters, attribute: { resource: "memory" } },
					"max",
				),
				queryTimeSeries(
					"capacity_observer_psi_some_avg60_pct",
					BUCKET_SECONDS,
					{ from, to },
					{ ...filters, attribute: { resource: "io" } },
					"max",
				),
				queryTimeSeries(
					"capacity_observer_psi_coverage_ratio",
					BUCKET_SECONDS,
					{ from, to },
					filters,
					"min",
				),
			]);
			const mapPoints = (points: TimeSeriesPoint[], scale = 1) =>
				points.map((point) => ({
					t: point.t.toISOString(),
					value: point.value * scale,
				}));
			return {
				cluster,
				windowSeconds: WINDOW_SECONDS,
				bucketSeconds: BUCKET_SECONDS,
				source: "clickhouse",
				cpuSomeAvg60Pct: mapPoints(cpu),
				memorySomeAvg60Pct: mapPoints(memory),
				ioSomeAvg60Pct: mapPoints(io),
				coverageRatioPct: mapPoints(coverage, 100),
				hasData: cpu.length + memory.length + io.length + coverage.length > 0,
			};
		} catch {
			return empty;
		}
	}

	async getTrends(cluster: string): Promise<CapacityTrendsSnapshot> {
		const to = new Date();
		const from = new Date(to.getTime() - TRENDS_WINDOW_SECONDS * 1000);
		const bucket = TRENDS_BUCKET_SECONDS;
		const clusterClause = `ResourceAttributes['k8s.cluster.name'] = '${escapeClickHouseString(cluster)}'`;
		const timeClause = `TimeUnix >= fromUnixTimestamp64Milli(${from.getTime()}) AND TimeUnix <= fromUnixTimestamp64Milli(${to.getTime()})`;

		const empty: CapacityTrendsSnapshot = {
			cluster,
			windowSeconds: TRENDS_WINDOW_SECONDS,
			bucketSeconds: bucket,
			source: "unavailable",
			utilizationPctByResource: {},
			actualUsagePctByResource: {},
			admitted: [],
			pending: [],
			reserving: [],
			latencyAvgMs: [],
			hasData: false,
		};

		const resourceSeriesSql = (metric: string) => `
		SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
		       Attributes['resource'] AS res,
		       avg(Value) AS v
		FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
		WHERE MetricName = '${escapeClickHouseString(metric)}' AND ${clusterClause} AND ${timeClause}
		GROUP BY bucket, res
		ORDER BY bucket ASC`;

		const workloadSeriesSql = (metric: string) => `
		SELECT bucket, sum(qv) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['queue'] AS q,
			       max(Value) AS qv
			FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
			WHERE MetricName = '${escapeClickHouseString(metric)}' AND ${clusterClause} AND ${timeClause}
			GROUP BY bucket, q
		) GROUP BY bucket ORDER BY bucket ASC`;

		const latencySql = `
		SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
		       sum(Sum) / nullIf(sum(Count), 0) * 1000 AS v
		FROM ${CLICKHOUSE_DB}.otel_metrics_histogram
		WHERE MetricName = 'dapr_runtime_workflow_scheduling_latency' AND ${clusterClause} AND ${timeClause}
		GROUP BY bucket
		HAVING sum(Count) > 0
		ORDER BY bucket ASC`;

		const memoryActualSql = `
		SELECT bucket, sum(v) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['id'] AS id,
			       max(Value) AS v
			FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
			WHERE MetricName = 'container_memory_working_set_bytes'
			  AND ${clusterClause}
			  AND ${timeClause}
			  AND Attributes['container'] != ''
			GROUP BY bucket, id
		) GROUP BY bucket ORDER BY bucket ASC`;

		const cpuActualSql = `
		SELECT bucket, sum(rate) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['id'] AS id,
			       greatest(0, (max(Value) - min(Value)) / greatest(1, dateDiff('second', min(TimeUnix), max(TimeUnix)))) AS rate
			FROM ${CLICKHOUSE_DB}.otel_metrics_sum
			WHERE MetricName = 'container_cpu_usage_seconds_total'
			  AND ${clusterClause}
			  AND ${timeClause}
			  AND Attributes['container'] != ''
			  AND Attributes['cpu'] = 'total'
			GROUP BY bucket, id
			HAVING count() > 1
		) GROUP BY bucket ORDER BY bucket ASC`;

		try {
			const [
				requestedRows,
				allocRows,
				admittedRows,
				pendingRows,
				reservingRows,
				latencyRows,
				actualMemoryRows,
				actualCpuRows,
				observedRows,
			] = await Promise.all([
				queryClickHouse(resourceSeriesSql("cluster_capacity_requested")),
				queryClickHouse(resourceSeriesSql("cluster_capacity_allocatable")),
				queryClickHouse(workloadSeriesSql("kueue_clusterqueue_admitted_workloads")),
				queryClickHouse(workloadSeriesSql("kueue_clusterqueue_pending_workloads")),
				queryClickHouse(workloadSeriesSql("kueue_clusterqueue_reserving_workloads")),
				queryClickHouse(latencySql),
				queryClickHouse(memoryActualSql),
				queryClickHouse(cpuActualSql),
				queryClickHouse(resourceSeriesSql("cluster_capacity_observed")),
			]);

			const allocByResBucket = new Map<string, number>();
			for (const row of allocRows) {
				const res = String(row.res ?? "");
				const t = new Date(String(row.bucket)).toISOString();
				allocByResBucket.set(`${res}|${t}`, Number(row.v) || 0);
			}

			const utilizationPctByResource: Record<
				string,
				CapacityPsiTrendPoint[]
			> = {};
			for (const row of requestedRows) {
				const res = String(row.res ?? "");
				const t = new Date(String(row.bucket)).toISOString();
				const requested = Number(row.v) || 0;
				const allocatable = allocByResBucket.get(`${res}|${t}`) ?? 0;
				if (allocatable <= 0) continue;
				const pct = Math.max(0, Math.min(100, (requested / allocatable) * 100));
				(utilizationPctByResource[res] ??= []).push({ t, value: pct });
			}

			const actualUsagePctByResource: Record<
				string,
				CapacityPsiTrendPoint[]
			> = {};
			const addActualSeries = (
				resource: "cpu" | "memory",
				rows: Record<string, unknown>[],
			) => {
				for (const row of rows) {
					const t = new Date(String(row.bucket)).toISOString();
					const allocatable = allocByResBucket.get(`${resource}|${t}`) ?? 0;
					if (allocatable <= 0) continue;
					const observed = Number(row.v) || 0;
					const pct = Math.max(0, Math.min(100, (observed / allocatable) * 100));
					(actualUsagePctByResource[resource] ??= []).push({ t, value: pct });
				}
			};
			const observedByResource = new Map<string, Record<string, unknown>[]>();
			for (const row of observedRows) {
				const res = String(row.res ?? "");
				if (!res) continue;
				const rows = observedByResource.get(res) ?? [];
				rows.push(row);
				observedByResource.set(res, rows);
			}
			addActualSeries(
				"memory",
				actualMemoryRows.length > 0
					? actualMemoryRows
					: (observedByResource.get("memory") ?? []),
			);
			addActualSeries(
				"cpu",
				actualCpuRows.length > 0
					? actualCpuRows
					: (observedByResource.get("cpu") ?? []),
			);

			const toSeries = (
				rows: Record<string, unknown>[],
			): CapacityPsiTrendPoint[] =>
				rows.map((row) => ({
					t: new Date(String(row.bucket)).toISOString(),
					value: Number(row.v) || 0,
				}));

			const admitted = toSeries(admittedRows);
			const pending = toSeries(pendingRows);
			const reserving = toSeries(reservingRows);
			const latencyAvgMs = toSeries(latencyRows);
			const hasData =
				Object.keys(utilizationPctByResource).length > 0 ||
				Object.keys(actualUsagePctByResource).length > 0 ||
				admitted.length + pending.length + reserving.length + latencyAvgMs.length >
					0;

			return {
				cluster,
				windowSeconds: TRENDS_WINDOW_SECONDS,
				bucketSeconds: bucket,
				source: "clickhouse",
				utilizationPctByResource,
				actualUsagePctByResource,
				admitted,
				pending,
				reserving,
				latencyAvgMs,
				hasData,
			};
		} catch {
			return empty;
		}
	}

	async getOwnerTimeline(input: {
		cluster: string;
		resource: string;
	}): Promise<CapacityOwnerTimeline> {
		const { cluster, resource } = input;
		const to = new Date();
		const from = new Date(to.getTime() - TRENDS_WINDOW_SECONDS * 1000);
		const bucket = TRENDS_BUCKET_SECONDS;
		const clusterClause = `ResourceAttributes['k8s.cluster.name'] = '${escapeClickHouseString(cluster)}'`;
		const resourceClause = `Attributes['resource'] = '${escapeClickHouseString(resource)}'`;
		const timeClause = `TimeUnix >= fromUnixTimestamp64Milli(${from.getTime()}) AND TimeUnix <= fromUnixTimestamp64Milli(${to.getTime()})`;
		const empty: CapacityOwnerTimeline = {
			cluster,
			resource,
			windowSeconds: TRENDS_WINDOW_SECONDS,
			bucketSeconds: bucket,
			owners: [],
			buckets: [],
			hasData: false,
		};

		try {
			const ownerSql = `
				SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
				       Attributes['owner_kind'] AS kind,
				       Attributes['owner_id'] AS id,
				       max(Value) AS v
				FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
				WHERE MetricName = 'capacity_observer_owner_requested' AND ${resourceClause} AND ${clusterClause} AND ${timeClause}
				GROUP BY bucket, kind, id
				ORDER BY bucket ASC`;
			const allocSql = `
				SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket, avg(Value) AS v
				FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
				WHERE MetricName = 'cluster_capacity_allocatable' AND ${resourceClause} AND ${clusterClause} AND ${timeClause}
				GROUP BY bucket ORDER BY bucket ASC`;
			const [ownerRows, allocRows] = await Promise.all([
				queryClickHouse(ownerSql),
				queryClickHouse(allocSql),
			]);

			const allocByBucket = new Map<string, number>();
			for (const row of allocRows) {
				allocByBucket.set(
					new Date(String(row.bucket)).toISOString(),
					Number(row.v) || 0,
				);
			}

			type Row = {
				t: string;
				key: string;
				kind: string;
				id: string;
				pct: number;
			};
			const rows: Row[] = [];
			const peakByOwner = new Map<
				string,
				{ kind: string; id: string; peak: number }
			>();
			for (const row of ownerRows) {
				const t = new Date(String(row.bucket)).toISOString();
				const alloc = allocByBucket.get(t) ?? 0;
				if (alloc <= 0) continue;
				const kind = String(row.kind ?? "");
				const id = String(row.id ?? "");
				if (!id) continue;
				const key = `${kind}:${id}`;
				const pct = Math.max(0, ((Number(row.v) || 0) / alloc) * 100);
				rows.push({ t, key, kind, id, pct });
				const prev = peakByOwner.get(key);
				if (!prev || pct > prev.peak) {
					peakByOwner.set(key, { kind, id, peak: pct });
				}
			}

			const ranked = [...peakByOwner.entries()].sort(
				(a, b) => b[1].peak - a[1].peak,
			);
			const topKeys = new Set(
				ranked.slice(0, OWNER_TIMELINE_TOP_N).map(([key]) => key),
			);
			const owners = ranked
				.filter(([key]) => topKeys.has(key))
				.map(([key, info]) => ({ key, kind: info.kind, id: info.id }));

			const bucketMap = new Map<string, CapacityOwnerTimelinePoint>();
			for (const row of rows) {
				const point = bucketMap.get(row.t) ?? {
					t: row.t,
					values: {},
					other: 0,
				};
				if (topKeys.has(row.key)) {
					point.values[row.key] = (point.values[row.key] ?? 0) + row.pct;
				} else {
					point.other += row.pct;
				}
				bucketMap.set(row.t, point);
			}
			const buckets = [...bucketMap.values()].sort((a, b) =>
				a.t.localeCompare(b.t),
			);

			return {
				cluster,
				resource,
				windowSeconds: TRENDS_WINDOW_SECONDS,
				bucketSeconds: bucket,
				owners,
				buckets,
				hasData: buckets.length > 0,
			};
		} catch {
			return empty;
		}
	}
}
