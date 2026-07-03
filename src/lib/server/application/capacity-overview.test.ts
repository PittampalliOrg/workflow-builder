import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationCapacityOverviewService,
	type CapacityBusinessWorkPort,
	type CapacityMetricsPort,
	type CapacityObserverPort,
	type CapacityOwnershipPort,
	type CapacityTelemetryPort,
} from "$lib/server/application/capacity-overview";
import type {
	CapacityBusinessWorkSummary,
	CapacityObserverResult,
	CapacityObserverSnapshot,
} from "$lib/types/capacity";

describe("ApplicationCapacityOverviewService", () => {
	let metrics: CapacityMetricsPort;
	let observer: CapacityObserverPort;
	let ownership: CapacityOwnershipPort;
	let businessWork: CapacityBusinessWorkPort;
	let telemetry: CapacityTelemetryPort;
	let service: ApplicationCapacityOverviewService;

	beforeEach(() => {
		metrics = {
			getSchedulingLatency: vi.fn(async (cluster: string) => ({
				cluster,
				windowSeconds: 300,
				p50Ms: 10,
				p95Ms: 50,
				samples: 2,
				sparkline: [{ t: "2026-01-01T00:00:00.000Z", valueMs: 12 }],
				hasData: true,
			})),
			getPsiTrends: vi.fn(async (cluster: string) => ({
				cluster,
				windowSeconds: 300,
				bucketSeconds: 30,
				source: "clickhouse" as const,
				cpuSomeAvg60Pct: [],
				memorySomeAvg60Pct: [],
				ioSomeAvg60Pct: [],
				coverageRatioPct: [],
				hasData: false,
			})),
			getTrends: vi.fn(async (cluster: string) => ({
				cluster,
				windowSeconds: 3600,
				bucketSeconds: 30,
				source: "clickhouse" as const,
				utilizationPctByResource: {},
				actualUsagePctByResource: {},
				admitted: [],
				pending: [],
				reserving: [],
				latencyAvgMs: [],
				hasData: false,
			})),
			getOwnerTimeline: vi.fn(async ({ cluster, resource }) => ({
				cluster,
				resource,
				windowSeconds: 3600,
				bucketSeconds: 30,
				owners: [],
				buckets: [],
				hasData: false,
			})),
		};
		observer = {
			fetchSnapshot: vi.fn(async () => ({
				available: true as const,
				snapshot: observerSnapshot(),
				error: null,
			})),
		};
		ownership = {
			enrich: vi.fn(async (snapshot: CapacityObserverSnapshot) => ({
				...snapshot,
				cluster: "enriched-cluster",
			})),
		};
		businessWork = {
			build: vi.fn(async () => businessWorkSummary()),
		};
		telemetry = {
			trace: vi.fn(async (_name, _payload, fn) => fn()),
		};
		service = new ApplicationCapacityOverviewService({
			metrics,
			observer,
			ownership,
			businessWork,
			telemetry,
		});
	});

	it("routes metric requests through telemetry and the metrics port", async () => {
		await expect(service.getSchedulingLatency("ryzen")).resolves.toMatchObject({
			cluster: "ryzen",
			p50Ms: 10,
		});
		await expect(service.getPsiTrends("ryzen")).resolves.toMatchObject({
			cluster: "ryzen",
		});
		await expect(service.getTrends("ryzen")).resolves.toMatchObject({
			cluster: "ryzen",
		});
		await expect(
			service.getOwnerTimeline({ cluster: "ryzen", resource: "cpu" }),
		).resolves.toMatchObject({ cluster: "ryzen", resource: "cpu" });

		expect(metrics.getSchedulingLatency).toHaveBeenCalledWith("ryzen");
		expect(metrics.getPsiTrends).toHaveBeenCalledWith("ryzen");
		expect(metrics.getTrends).toHaveBeenCalledWith("ryzen");
		expect(metrics.getOwnerTimeline).toHaveBeenCalledWith({
			cluster: "ryzen",
			resource: "cpu",
		});
		expect(telemetry.trace).toHaveBeenCalledWith(
			"getSchedulingLatency",
			["ryzen"],
			expect.any(Function),
		);
	});

	it("enriches available observer snapshots and builds business work with workspace context", async () => {
		const context = { projectId: "project-1", workspaceSlug: "main" };

		await expect(service.getOverview(context)).resolves.toMatchObject({
			observer: {
				available: true,
				snapshot: { cluster: "enriched-cluster" },
			},
			businessWork: {
				totals: { activeWork: 1 },
			},
		});
		expect(observer.fetchSnapshot).toHaveBeenCalled();
		expect(ownership.enrich).toHaveBeenCalledWith(observerSnapshot(), context);
		expect(businessWork.build).toHaveBeenCalledWith(
			expect.objectContaining({ cluster: "enriched-cluster" }),
			context,
		);
	});

	it("returns empty business work without ownership lookup when observer is unavailable", async () => {
		vi.mocked(observer.fetchSnapshot).mockResolvedValueOnce({
			available: false,
			snapshot: null,
			error: "observer down",
		} as CapacityObserverResult);

		await expect(
			service.getOverview({ projectId: null, workspaceSlug: "main" }),
		).resolves.toMatchObject({
			observer: { available: false, error: "observer down" },
			businessWork: {
				active: [],
				recent: [],
				infrastructure: [],
				totals: { activeWork: 0 },
			},
		});
		expect(ownership.enrich).not.toHaveBeenCalled();
		expect(businessWork.build).not.toHaveBeenCalled();
	});
});

function observerSnapshot(): CapacityObserverSnapshot {
	return {
		sampledAt: "2026-01-01T00:00:00.000Z",
		cluster: "ryzen",
		flavor: "kubernetes",
		resources: [],
		queues: [],
		localQueues: 0,
		sessionCapacity: [],
		blockedWorkloads: [],
		contributors: [],
		nodePressure: {},
		criticalHealth: [],
		recentPreemptions: 0,
		warnings: [],
	};
}

function businessWorkSummary(): CapacityBusinessWorkSummary {
	return {
		active: [],
		recent: [],
		infrastructure: [],
		totals: {
			activeWork: 1,
			recentWork: 0,
			unattributedInfrastructure: 0,
			requestedResources: {},
			observedResources: {},
			blockedWorkloads: 0,
		},
		generatedAt: "2026-01-01T00:00:00.000Z",
	};
}
