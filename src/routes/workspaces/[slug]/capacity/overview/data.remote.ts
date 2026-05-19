import { query } from '$app/server';
import {
	queryHistogramPercentiles,
	queryTimeSeries
} from '$lib/server/otel/metrics';
import { fetchCapacityObserverSnapshot } from '$lib/server/capacity/observer';
import type { CapacityOverviewSummary } from '$lib/types/capacity';

const WINDOW_SECONDS = 300; // 5 min — recent enough to feel "now", smooth enough to avoid jitter
const BUCKET_SECONDS = 30;
const METRICS_DEFAULT_CLUSTER = process.env.METRICS_DEFAULT_CLUSTER ?? 'dev';

export type SchedulingLatencySnapshot = {
	cluster: string;
	windowSeconds: number;
	p50Ms: number | null;
	p95Ms: number | null;
	samples: number;
	sparkline: Array<{ t: string; valueMs: number }>;
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
	async (): Promise<SchedulingLatencySnapshot> => {
		const to = new Date();
		const from = new Date(to.getTime() - WINDOW_SECONDS * 1000);
		const filters = { cluster: METRICS_DEFAULT_CLUSTER };
		try {
			const [percentiles, series] = await Promise.all([
				queryHistogramPercentiles(
					'dapr_runtime_workflow_scheduling_latency',
					[0.5, 0.95],
					{ from, to },
					filters
				),
				queryTimeSeries(
					'dapr_runtime_workflow_scheduling_latency',
					BUCKET_SECONDS,
					{ from, to },
					filters,
					'avg'
				)
			]);
			const sparkline = series.map((p) => ({
				t: p.t.toISOString(),
				valueMs: p.value * 1000
			}));
			return {
				cluster: METRICS_DEFAULT_CLUSTER,
				windowSeconds: WINDOW_SECONDS,
				p50Ms: percentiles.count > 0 ? percentiles.percentiles.p50 * 1000 : null,
				p95Ms: percentiles.count > 0 ? percentiles.percentiles.p95 * 1000 : null,
				samples: percentiles.count,
				sparkline,
				hasData: percentiles.count > 0
			};
		} catch {
			return {
				cluster: METRICS_DEFAULT_CLUSTER,
				windowSeconds: WINDOW_SECONDS,
				p50Ms: null,
				p95Ms: null,
				samples: 0,
				sparkline: [],
				hasData: false
			};
		}
	}
);

export const getCapacityOverview = query(async (): Promise<CapacityOverviewSummary> => {
	return {
		observer: await fetchCapacityObserverSnapshot()
	};
});
