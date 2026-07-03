import type {
	CapacityBusinessWorkSummary,
	CapacityObserverResult,
	CapacityObserverSnapshot,
	CapacityOverviewSummary,
} from "$lib/types/capacity";

export type CapacityOverviewContext = {
	projectId: string | null | undefined;
	workspaceSlug: string;
};

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

export type CapacityTrendsSnapshot = {
	cluster: string;
	windowSeconds: number;
	bucketSeconds: number;
	source: "clickhouse" | "unavailable";
	utilizationPctByResource: Record<string, CapacityPsiTrendPoint[]>;
	actualUsagePctByResource: Record<string, CapacityPsiTrendPoint[]>;
	admitted: CapacityPsiTrendPoint[];
	pending: CapacityPsiTrendPoint[];
	reserving: CapacityPsiTrendPoint[];
	latencyAvgMs: CapacityPsiTrendPoint[];
	hasData: boolean;
};

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

export type CapacityMetricsPort = {
	getSchedulingLatency(cluster: string): Promise<SchedulingLatencySnapshot>;
	getPsiTrends(cluster: string): Promise<CapacityPsiTrendsSnapshot>;
	getTrends(cluster: string): Promise<CapacityTrendsSnapshot>;
	getOwnerTimeline(input: {
		cluster: string;
		resource: string;
	}): Promise<CapacityOwnerTimeline>;
};

export type CapacityObserverPort = {
	fetchSnapshot(): Promise<CapacityObserverResult>;
};

export type CapacityOwnershipPort = {
	enrich(
		snapshot: CapacityObserverSnapshot,
		context: CapacityOverviewContext,
	): Promise<CapacityObserverSnapshot>;
};

export type CapacityBusinessWorkPort = {
	build(
		snapshot: CapacityObserverSnapshot,
		context: CapacityOverviewContext,
	): Promise<CapacityBusinessWorkSummary>;
};

export type CapacityTelemetryPort = {
	trace<T>(name: string, payload: unknown, fn: () => Promise<T>): Promise<T>;
};

export class ApplicationCapacityOverviewService {
	constructor(
		private readonly deps: {
			metrics: CapacityMetricsPort;
			observer: CapacityObserverPort;
			ownership: CapacityOwnershipPort;
			businessWork: CapacityBusinessWorkPort;
			telemetry: CapacityTelemetryPort;
		},
	) {}

	getSchedulingLatency(cluster: string): Promise<SchedulingLatencySnapshot> {
		return this.deps.telemetry.trace("getSchedulingLatency", [cluster], () =>
			this.deps.metrics.getSchedulingLatency(cluster),
		);
	}

	getPsiTrends(cluster: string): Promise<CapacityPsiTrendsSnapshot> {
		return this.deps.telemetry.trace("getCapacityPsiTrends", [cluster], () =>
			this.deps.metrics.getPsiTrends(cluster),
		);
	}

	getTrends(cluster: string): Promise<CapacityTrendsSnapshot> {
		return this.deps.telemetry.trace("getCapacityTrends", [cluster], () =>
			this.deps.metrics.getTrends(cluster),
		);
	}

	getOwnerTimeline(input: {
		cluster: string;
		resource: string;
	}): Promise<CapacityOwnerTimeline> {
		return this.deps.telemetry.trace("getCapacityOwnerTimeline", [input], () =>
			this.deps.metrics.getOwnerTimeline(input),
		);
	}

	getOverview(context: CapacityOverviewContext): Promise<CapacityOverviewSummary> {
		return this.deps.telemetry.trace("getCapacityOverview", [], async () => {
			const observer = await this.deps.observer.fetchSnapshot();
			let businessWork = emptyBusinessWorkSummary();
			if (observer.available) {
				observer.snapshot = await this.deps.ownership.enrich(
					observer.snapshot,
					context,
				);
				businessWork = await this.deps.businessWork.build(
					observer.snapshot,
					context,
				);
			}
			return { observer, businessWork };
		});
	}
}

function emptyBusinessWorkSummary(): CapacityBusinessWorkSummary {
	return {
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
}
