// Metrics query helpers backed by the OpenTelemetry-collector ClickHouse exporter
// tables (otel.otel_metrics_sum / _gauge / _histogram).
//
// Five primitives cover every metric panel in the workflow-builder UI today:
//   queryHistogramPercentiles  — P50/P95/Pn from histogram buckets (Kueue wait,
//                                Dapr workflow latency, agent-sandbox startup)
//   queryHistogramSum          — total sum + count (Kueue wait totals,
//                                cost-of-time aggregates)
//   queryHistogramGrouped      — same as percentiles but group by attributes
//                                (warm-pool hit-rate by launch_type + template)
//   queryCounterDelta          — counter increment over a window
//                                (kueue_preempted_workloads_total, workflow
//                                failures)
//   queryGaugeLatest           — latest gauge value
//                                (kueue_pending_workloads, agent_sandboxes)
//   queryTimeSeries            — bucketed time-series for sparklines
//
// Everything goes through queryClickHouse() in ./clickhouse.ts; this file is
// only a typed SQL builder + JS-side histogram interpolator.

import {
	CLICKHOUSE_DB,
	escapeClickHouseString,
	queryClickHouse,
} from "./clickhouse";

export type AttributeFilter = Record<string, string | string[]>;

export type MetricFilter = {
	/** Filters against the per-data-point Attributes map. */
	attribute?: AttributeFilter;
	/** Filters against ResourceAttributes (cluster, pod, namespace, etc.). */
	resource?: AttributeFilter;
	/** Shorthand for resource['k8s.cluster.name']. */
	cluster?: string;
};

export type TimeRange = { from: Date; to: Date };

export type HistogramPercentileResult = {
	count: number;
	sum: number;
	percentiles: Record<string, number>;
};

export type HistogramGroupedResult = {
	labels: Record<string, string>;
	count: number;
	sum: number;
	percentiles: Record<string, number>;
};

export type CounterDeltaResult = { delta: number; samples: number };

export type GaugeLatestResult = { value: number; t: Date } | null;

export type TimeSeriesPoint = { t: Date; value: number };

export type TimeSeriesAggregation = "sum" | "avg" | "max" | "min" | "p95";

// ---------------------------------------------------------------------------
// SQL building helpers
// ---------------------------------------------------------------------------

function toClickHouseTs(date: Date): string {
	// fromUnixTimestamp64Milli takes an integer millisecond epoch and yields a
	// DateTime64(3) that's comparable against TimeUnix DateTime64(9) without
	// loss of precision for any timestamp the UI cares about.
	return `fromUnixTimestamp64Milli(${date.getTime()})`;
}

function quoteValue(value: string): string {
	return `'${escapeClickHouseString(value)}'`;
}

function buildMapFilter(
	column: "Attributes" | "ResourceAttributes",
	filter: AttributeFilter | undefined,
): string[] {
	if (!filter) return [];
	const clauses: string[] = [];
	for (const [key, raw] of Object.entries(filter)) {
		const escapedKey = escapeClickHouseString(key);
		if (Array.isArray(raw)) {
			if (raw.length === 0) {
				// Empty IN clause would match nothing; encode as 1=0 so callers don't
				// accidentally return everything when they pass an empty allowlist.
				clauses.push("1 = 0");
				continue;
			}
			const valueList = raw.map(quoteValue).join(", ");
			clauses.push(`${column}['${escapedKey}'] IN (${valueList})`);
		} else {
			clauses.push(`${column}['${escapedKey}'] = ${quoteValue(raw)}`);
		}
	}
	return clauses;
}

function buildWhereClause(
	metric: string,
	range: TimeRange,
	filters: MetricFilter | undefined,
): string {
	const clauses: string[] = [
		`MetricName = ${quoteValue(metric)}`,
		`TimeUnix >= ${toClickHouseTs(range.from)}`,
		`TimeUnix <= ${toClickHouseTs(range.to)}`,
	];
	if (filters?.cluster) {
		clauses.push(
			`ResourceAttributes['k8s.cluster.name'] = ${quoteValue(filters.cluster)}`,
		);
	}
	clauses.push(...buildMapFilter("Attributes", filters?.attribute));
	clauses.push(...buildMapFilter("ResourceAttributes", filters?.resource));
	return clauses.join(" AND ");
}

// ---------------------------------------------------------------------------
// Histogram bucket interpolation (TS-side)
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return 0;
}

function asNumberArray(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value.map((v) => asNumber(v));
}

function mergeBuckets(
	rows: Array<{ counts: number[]; bounds: number[]; rowSum: number }>,
): { mergedCounts: number[]; bounds: number[]; total: number; sum: number } {
	if (rows.length === 0) {
		return { mergedCounts: [], bounds: [], total: 0, sum: 0 };
	}
	// Histograms with the same metric+attribute set should all share the same
	// ExplicitBounds. We pick the first row's bounds and skip rows whose bounds
	// disagree (rare cross-version collector quirk).
	const bounds = rows[0].bounds;
	const bucketCount = bounds.length + 1;
	const mergedCounts = new Array<number>(bucketCount).fill(0);
	let total = 0;
	let sum = 0;
	for (const row of rows) {
		if (row.bounds.length !== bounds.length) continue;
		let consistent = true;
		for (let i = 0; i < bounds.length; i++) {
			if (Math.abs(row.bounds[i] - bounds[i]) > 1e-9) {
				consistent = false;
				break;
			}
		}
		if (!consistent) continue;
		for (let i = 0; i < bucketCount; i++) {
			mergedCounts[i] += row.counts[i] ?? 0;
		}
		sum += row.rowSum;
		total += row.counts.reduce((a, b) => a + (b ?? 0), 0);
	}
	return { mergedCounts, bounds, total, sum };
}

function interpolatePercentile(
	mergedCounts: number[],
	bounds: number[],
	total: number,
	q: number,
): number {
	if (total <= 0) return 0;
	const target = total * q;
	let cumulative = 0;
	for (let i = 0; i < mergedCounts.length; i++) {
		const bucketLo = i === 0 ? 0 : bounds[i - 1];
		const bucketHi = i < bounds.length ? bounds[i] : bucketLo;
		const count = mergedCounts[i] ?? 0;
		const next = cumulative + count;
		if (next >= target) {
			if (count === 0) return bucketLo;
			if (i === mergedCounts.length - 1 && bounds.length > 0) {
				// Overflow (+inf) bucket — best we can do is return the last bound;
				// the metric is at least that big, and bucket interpolation has no
				// upper edge.
				return bounds[bounds.length - 1];
			}
			const fraction = (target - cumulative) / count;
			return bucketLo + (bucketHi - bucketLo) * fraction;
		}
		cumulative = next;
	}
	return bounds[bounds.length - 1] ?? 0;
}

// ---------------------------------------------------------------------------
// queryHistogramPercentiles
// ---------------------------------------------------------------------------

export async function queryHistogramPercentiles(
	metric: string,
	percentiles: number[],
	range: TimeRange,
	filters?: MetricFilter,
): Promise<HistogramPercentileResult> {
	const where = buildWhereClause(metric, range, filters);
	const sql = `
		SELECT
			BucketCounts AS counts,
			ExplicitBounds AS bounds,
			Sum AS rowSum
		FROM ${CLICKHOUSE_DB}.otel_metrics_histogram
		WHERE ${where}`;
	const rows = await queryClickHouse(sql);
	const parsed = rows.map((r) => ({
		counts: asNumberArray(r.counts),
		bounds: asNumberArray(r.bounds),
		rowSum: asNumber(r.rowSum),
	}));
	const { mergedCounts, bounds, total, sum } = mergeBuckets(parsed);
	const result: HistogramPercentileResult = {
		count: total,
		sum,
		percentiles: {},
	};
	for (const q of percentiles) {
		const key = `p${Math.round(q * 100)}`;
		result.percentiles[key] = interpolatePercentile(
			mergedCounts,
			bounds,
			total,
			q,
		);
	}
	return result;
}

// ---------------------------------------------------------------------------
// queryHistogramSum
// ---------------------------------------------------------------------------

export async function queryHistogramSum(
	metric: string,
	range: TimeRange,
	filters?: MetricFilter,
): Promise<{ sum: number; count: number }> {
	const where = buildWhereClause(metric, range, filters);
	const sql = `
		SELECT
			sum(Sum) AS totalSum,
			sum(Count) AS totalCount
		FROM ${CLICKHOUSE_DB}.otel_metrics_histogram
		WHERE ${where}`;
	const [row] = await queryClickHouse(sql);
	return {
		sum: asNumber(row?.totalSum),
		count: asNumber(row?.totalCount),
	};
}

// ---------------------------------------------------------------------------
// queryHistogramGrouped
// ---------------------------------------------------------------------------

export async function queryHistogramGrouped(
	metric: string,
	groupBy: string[],
	percentiles: number[],
	range: TimeRange,
	filters?: MetricFilter,
): Promise<HistogramGroupedResult[]> {
	const where = buildWhereClause(metric, range, filters);
	const groupExprs = groupBy.map(
		(key, idx) =>
			`Attributes['${escapeClickHouseString(key)}'] AS group_${idx}`,
	);
	const groupByCols = groupBy.map((_, idx) => `group_${idx}`).join(", ");
	const sql = `
		SELECT
			${groupExprs.join(", ")}${groupExprs.length ? "," : ""}
			BucketCounts AS counts,
			ExplicitBounds AS bounds,
			Sum AS rowSum
		FROM ${CLICKHOUSE_DB}.otel_metrics_histogram
		WHERE ${where}
		${groupExprs.length ? "ORDER BY " + groupByCols : ""}`;
	const rows = await queryClickHouse(sql);
	// Bucket rows by group key.
	const byGroup = new Map<
		string,
		{
			labels: Record<string, string>;
			rows: Array<{ counts: number[]; bounds: number[]; rowSum: number }>;
		}
	>();
	for (const r of rows) {
		const labels: Record<string, string> = {};
		groupBy.forEach((key, idx) => {
			labels[key] = String(r[`group_${idx}`] ?? "");
		});
		const k = JSON.stringify(labels);
		let entry = byGroup.get(k);
		if (!entry) {
			entry = { labels, rows: [] };
			byGroup.set(k, entry);
		}
		entry.rows.push({
			counts: asNumberArray(r.counts),
			bounds: asNumberArray(r.bounds),
			rowSum: asNumber(r.rowSum),
		});
	}
	const out: HistogramGroupedResult[] = [];
	for (const entry of byGroup.values()) {
		const { mergedCounts, bounds, total, sum } = mergeBuckets(entry.rows);
		const result: HistogramGroupedResult = {
			labels: entry.labels,
			count: total,
			sum,
			percentiles: {},
		};
		for (const q of percentiles) {
			result.percentiles[`p${Math.round(q * 100)}`] = interpolatePercentile(
				mergedCounts,
				bounds,
				total,
				q,
			);
		}
		out.push(result);
	}
	return out;
}

// ---------------------------------------------------------------------------
// queryCounterDelta
// ---------------------------------------------------------------------------

export async function queryCounterDelta(
	metric: string,
	range: TimeRange,
	filters?: MetricFilter,
): Promise<CounterDeltaResult> {
	// OTEL `sum` metrics are cumulative; the delta over the window is
	// max(Value) - min(Value) per series, then summed across series. We
	// approximate by grouping on the full Attributes map.
	const where = buildWhereClause(metric, range, filters);
	const sql = `
		SELECT
			max(Value) - min(Value) AS rowDelta,
			count() AS samples
		FROM ${CLICKHOUSE_DB}.otel_metrics_sum
		WHERE ${where}
		GROUP BY Attributes, ResourceAttributes`;
	const rows = await queryClickHouse(sql);
	let delta = 0;
	let samples = 0;
	for (const r of rows) {
		delta += asNumber(r.rowDelta);
		samples += asNumber(r.samples);
	}
	return { delta: Math.max(0, delta), samples };
}

// ---------------------------------------------------------------------------
// queryGaugeLatest
// ---------------------------------------------------------------------------

export async function queryGaugeLatest(
	metric: string,
	range: TimeRange,
	filters?: MetricFilter,
): Promise<GaugeLatestResult> {
	const where = buildWhereClause(metric, range, filters);
	const sql = `
		SELECT Value AS v, TimeUnix AS t
		FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
		WHERE ${where}
		ORDER BY TimeUnix DESC
		LIMIT 1`;
	const [row] = await queryClickHouse(sql);
	if (!row) return null;
	return {
		value: asNumber(row.v),
		t: new Date(String(row.t)),
	};
}

// ---------------------------------------------------------------------------
// queryTimeSeries
// ---------------------------------------------------------------------------

export async function queryTimeSeries(
	metric: string,
	bucketSeconds: number,
	range: TimeRange,
	filters?: MetricFilter,
	aggregation: TimeSeriesAggregation = "avg",
): Promise<TimeSeriesPoint[]> {
	const where = buildWhereClause(metric, range, filters);
	// Try sum first (counters/values), then gauge, then histogram (sum/count).
	// We pick a table based on the most-likely metric category. For workflow-
	// builder use today, the metric category is known per call so we let the
	// caller pick via the metric name suffix convention:
	//   *_total      → sum
	//   *_seconds    → histogram → use Sum/Count for "avg" or BucketCounts for p95
	//   *_count      → sum
	//   otherwise    → gauge
	const isCounter = metric.endsWith("_total") || metric.endsWith("_count");
	const isHistogram =
		metric.endsWith("_seconds") || metric.endsWith("_milliseconds");
	let table: string;
	let valueExpr: string;
	if (isHistogram) {
		table = "otel_metrics_histogram";
		valueExpr = aggregation === "sum" ? "sum(Sum)" : "sum(Sum) / nullIf(sum(Count), 0)";
	} else if (isCounter) {
		table = "otel_metrics_sum";
		valueExpr = aggregation === "max" ? "max(Value)" : "sum(Value)";
	} else {
		table = "otel_metrics_gauge";
		valueExpr =
			aggregation === "max"
				? "max(Value)"
				: aggregation === "min"
					? "min(Value)"
					: "avg(Value)";
	}
	const sql = `
		SELECT
			toStartOfInterval(TimeUnix, INTERVAL ${Math.max(1, Math.floor(bucketSeconds))} SECOND) AS bucket,
			${valueExpr} AS v
		FROM ${CLICKHOUSE_DB}.${table}
		WHERE ${where}
		GROUP BY bucket
		ORDER BY bucket ASC`;
	const rows = await queryClickHouse(sql);
	return rows.map((r) => ({
		t: new Date(String(r.bucket)),
		value: asNumber(r.v),
	}));
}

// ---------------------------------------------------------------------------
// Internal helpers exposed for tests
// ---------------------------------------------------------------------------

export const __internal = {
	buildWhereClause,
	interpolatePercentile,
	mergeBuckets,
};
