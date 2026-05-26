import { getRequestEvent, query } from "$app/server";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  queryHistogramPercentiles,
  queryTimeSeries,
} from "$lib/server/otel/metrics";
import {
  CLICKHOUSE_DB,
  escapeClickHouseString,
  queryClickHouse,
} from "$lib/server/otel/clickhouse";
import { fetchCapacityObserverSnapshot } from "$lib/server/capacity/observer";
import { buildCapacityBusinessWork } from "$lib/server/capacity/business-work";
import { enrichCapacitySnapshotOwnership } from "$lib/server/capacity/ownership";
import { setSpanValue } from "$lib/server/observability/content";
import type {
  CapacityBusinessWorkSummary,
  CapacityOverviewSummary,
} from "$lib/types/capacity";

const WINDOW_SECONDS = 300; // 5 min — recent enough to feel "now", smooth enough to avoid jitter
const BUCKET_SECONDS = 30;
const capacityRemoteTracer = trace.getTracer(
  "workflow-builder.capacity-remote",
);

async function traceCapacityRemote<T>(
  name: string,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const parentSpan = trace.getActiveSpan();
  const input = { remoteCall: name, payload };
  setSpanValue(parentSpan, "input", input);

  return capacityRemoteTracer.startActiveSpan(
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

// The cluster whose metrics the trend charts query is passed in explicitly by
// the caller (the page sources it from the observer snapshot it already
// renders), so the trends deterministically match the snapshot panel's cluster.
// The hub ClickHouse holds metrics for every spoke keyed by k8s.cluster.name,
// so the cluster argument is required — there is no default.

export type SchedulingLatencySnapshot = {
  cluster: string;
  windowSeconds: number;
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  sparkline: Array<{ t: string; valueMs: number }>;
  hasData: boolean;
};

export type CapacityPsiTrendPoint = { t: string; value: number };

export type CapacityPsiTrendsSnapshot = {
  cluster: string;
  windowSeconds: number;
  bucketSeconds: number;
  source: "clickhouse" | "unavailable";
  cpuSomeAvg60Pct: CapacityPsiTrendPoint[];
  memorySomeAvg60Pct: CapacityPsiTrendPoint[];
  ioSomeAvg60Pct: CapacityPsiTrendPoint[];
  coverageRatioPct: CapacityPsiTrendPoint[];
  hasData: boolean;
};

/**
 * Dapr workflow scheduling-latency P50/P95 + sparkline over the last 5 minutes.
 * Reads `dapr_runtime_workflow_scheduling_latency` (Histogram, seconds).
 *
 * Wrapped in try/catch — page renders without the badge when ClickHouse is
 * unavailable, rather than failing the whole capacity overview.
 */
export const getSchedulingLatency = query(
  "unchecked",
  async (cluster: string): Promise<SchedulingLatencySnapshot> => {
    return traceCapacityRemote("getSchedulingLatency", [cluster], async () => {
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
        const sparkline = series.map((p) => ({
          t: p.t.toISOString(),
          valueMs: p.value * 1000,
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
    });
  },
);

export const getCapacityPsiTrends = query(
  "unchecked",
  async (cluster: string): Promise<CapacityPsiTrendsSnapshot> => {
    return traceCapacityRemote("getCapacityPsiTrends", [cluster], async () => {
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
        const mapPoints = (points: typeof cpu, scale = 1) =>
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
    });
  },
);

// ---------------------------------------------------------------------------
// Capacity trends from ClickHouse (durable, populate instantly — unlike the
// page's in-memory client buffer which resets on reload/resource-flip and
// pauses when the tab is hidden). The capacity-observer already exports
// `cluster_capacity_headroom` / `cluster_capacity_rendered_budget` per
// resource and `kueue_clusterqueue_*_workloads` per queue; the OTEL collector
// scrapes them into ClickHouse alongside the PSI metrics. Fixed 60m window;
// the trends panel windows this client-side per the 5m/15m/60m toggle.
// ---------------------------------------------------------------------------
const TRENDS_WINDOW_SECONDS = 3600;
const TRENDS_BUCKET_SECONDS = 30;

export type CapacityTrendsSnapshot = {
  cluster: string;
  windowSeconds: number;
  bucketSeconds: number;
  source: "clickhouse" | "unavailable";
  /** utilization % (requested ÷ allocatable, capped 0–100) per resource, per bucket. */
  utilizationPctByResource: Record<string, CapacityPsiTrendPoint[]>;
  /** observed utilization % from cAdvisor metrics where available (CPU, memory). */
  actualUsagePctByResource: Record<string, CapacityPsiTrendPoint[]>;
  admitted: CapacityPsiTrendPoint[];
  pending: CapacityPsiTrendPoint[];
  reserving: CapacityPsiTrendPoint[];
  latencyAvgMs: CapacityPsiTrendPoint[];
  hasData: boolean;
};

export const getCapacityTrends = query(
  "unchecked",
  async (cluster: string): Promise<CapacityTrendsSnapshot> => {
    return traceCapacityRemote("getCapacityTrends", [cluster], async () => {
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

      // Per-(bucket,resource) average for a cluster_capacity_* gauge.
      const resourceSeriesSql = (metric: string) => `
		SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
		       Attributes['resource'] AS res,
		       avg(Value) AS v
		FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
		WHERE MetricName = '${escapeClickHouseString(metric)}' AND ${clusterClause} AND ${timeClause}
		GROUP BY bucket, res
		ORDER BY bucket ASC`;

      // Cluster-total workload count over time: max per (bucket,queue), then sum
      // across queues — avoids double-counting when a queue scrapes twice/bucket.
      const workloadSeriesSql = (metric: string) => `
		SELECT bucket, sum(qv) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['queue'] AS q,
			       max(Value) AS qv
			FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
			WHERE MetricName = '${escapeClickHouseString(metric)}' AND ${clusterClause} AND ${timeClause}
			GROUP BY bucket, q
		) GROUP BY bucket ORDER BY bucket ASC`;

      // Avg scheduling latency (ms) per bucket from the histogram table (Sum/Count).
      // queryTimeSeries can't reach this — the metric name lacks a histogram suffix.
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
        ] = await Promise.all([
          queryClickHouse(resourceSeriesSql("cluster_capacity_requested")),
          queryClickHouse(resourceSeriesSql("cluster_capacity_allocatable")),
          queryClickHouse(
            workloadSeriesSql("kueue_clusterqueue_admitted_workloads"),
          ),
          queryClickHouse(
            workloadSeriesSql("kueue_clusterqueue_pending_workloads"),
          ),
          queryClickHouse(
            workloadSeriesSql("kueue_clusterqueue_reserving_workloads"),
          ),
          queryClickHouse(latencySql),
          queryClickHouse(memoryActualSql),
          queryClickHouse(cpuActualSql),
        ]);

        // utilization % = requested ÷ allocatable, capped 0–100. Rises as
        // workloads consume capacity (unlike headroom ÷ Kueue-budget, which
        // pegs at 100 on a cluster whose allocatable dwarfs the admission cap).
        const allocByResBucket = new Map<string, number>();
        for (const r of allocRows) {
          const res = String(r.res ?? "");
          const t = new Date(String(r.bucket)).toISOString();
          allocByResBucket.set(`${res}|${t}`, Number(r.v) || 0);
        }
        const utilizationPctByResource: Record<
          string,
          CapacityPsiTrendPoint[]
        > = {};
        for (const r of requestedRows) {
          const res = String(r.res ?? "");
          const t = new Date(String(r.bucket)).toISOString();
          const requested = Number(r.v) || 0;
          const allocatable = allocByResBucket.get(`${res}|${t}`) ?? 0;
          if (allocatable <= 0) continue;
          const pct = Math.max(
            0,
            Math.min(100, (requested / allocatable) * 100),
          );
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
          for (const r of rows) {
            const t = new Date(String(r.bucket)).toISOString();
            const allocatable = allocByResBucket.get(`${resource}|${t}`) ?? 0;
            if (allocatable <= 0) continue;
            const observed = Number(r.v) || 0;
            const pct = Math.max(0, Math.min(100, (observed / allocatable) * 100));
            (actualUsagePctByResource[resource] ??= []).push({ t, value: pct });
          }
        };
        addActualSeries("memory", actualMemoryRows);
        addActualSeries("cpu", actualCpuRows);

        const toSeries = (
          rows: Record<string, unknown>[],
        ): CapacityPsiTrendPoint[] =>
          rows.map((r) => ({
            t: new Date(String(r.bucket)).toISOString(),
            value: Number(r.v) || 0,
          }));

        const admitted = toSeries(admittedRows);
        const pending = toSeries(pendingRows);
        const reserving = toSeries(reservingRows);
        const latencyAvgMs = toSeries(latencyRows);
        const hasData =
          Object.keys(utilizationPctByResource).length > 0 ||
          Object.keys(actualUsagePctByResource).length > 0 ||
          admitted.length +
            pending.length +
            reserving.length +
            latencyAvgMs.length >
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
    });
  },
);

// ---------------------------------------------------------------------------
// Per-owner capacity timeline — drives the stacked-by-owner utilization chart
// (each band is a session/workflow/benchmark). `capacity_observer_owner_requested`
// is labelled with owner_kind + owner_id + resource, so we can attribute each
// time bucket's utilization to the actual entities consuming it. owner_id maps
// 1:1 to the businessWork item ids the page already resolved to links.
// ---------------------------------------------------------------------------
export type CapacityOwnerTimelinePoint = {
  t: string;
  values: Record<string, number>;
  other: number;
};
export type CapacityOwnerTimeline = {
  cluster: string;
  resource: string;
  windowSeconds: number;
  bucketSeconds: number;
  owners: Array<{ key: string; kind: string; id: string }>;
  buckets: CapacityOwnerTimelinePoint[];
  hasData: boolean;
};

const OWNER_TIMELINE_TOP_N = 8;

export const getCapacityOwnerTimeline = query(
  "unchecked",
  async ({
    cluster,
    resource,
  }: {
    cluster: string;
    resource: string;
  }): Promise<CapacityOwnerTimeline> => {
    return traceCapacityRemote(
      "getCapacityOwnerTimeline",
      [{ cluster, resource }],
      async () => {
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
          // Per-(bucket,owner) requested + per-bucket allocatable (for %).
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
          for (const r of allocRows) {
            allocByBucket.set(
              new Date(String(r.bucket)).toISOString(),
              Number(r.v) || 0,
            );
          }

          // Group → owner key, accumulate per-bucket %, and track peak per owner.
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
          for (const r of ownerRows) {
            const t = new Date(String(r.bucket)).toISOString();
            const alloc = allocByBucket.get(t) ?? 0;
            if (alloc <= 0) continue;
            const kind = String(r.kind ?? "");
            const id = String(r.id ?? "");
            if (!id) continue;
            const key = `${kind}:${id}`;
            const pct = Math.max(0, ((Number(r.v) || 0) / alloc) * 100);
            rows.push({ t, key, kind, id, pct });
            const prev = peakByOwner.get(key);
            if (!prev || pct > prev.peak)
              peakByOwner.set(key, { kind, id, peak: pct });
          }

          // Top-N owners by peak; the rest collapse into "other".
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
            if (topKeys.has(row.key))
              point.values[row.key] = (point.values[row.key] ?? 0) + row.pct;
            else point.other += row.pct;
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
      },
    );
  },
);

export const getCapacityOverview = query(
  async (): Promise<CapacityOverviewSummary> => {
    return traceCapacityRemote("getCapacityOverview", [], async () => {
      const observer = await fetchCapacityObserverSnapshot();
      let businessWork: CapacityBusinessWorkSummary = {
        active: [],
        recent: [],
        infrastructure: [],
        totals: {
          activeWork: 0,
          recentWork: 0,
          unattributedInfrastructure: 0,
          requestedResources: {},
          observedResources: {},
          blockedWorkloads: 0,
        },
        generatedAt: new Date().toISOString(),
      };
      if (observer.available) {
        const event = getRequestEvent();
        const context = {
          projectId: event.locals.session?.projectId,
          workspaceSlug: event.params.slug ?? "default",
        };
        observer.snapshot = await enrichCapacitySnapshotOwnership(
          observer.snapshot,
          {
            projectId: context.projectId,
            workspaceSlug: context.workspaceSlug,
          },
        );
        businessWork = await buildCapacityBusinessWork(
          observer.snapshot,
          context,
        );
      }
      return {
        observer,
        businessWork,
      };
    });
  },
);
