import { describe, expect, it, vi } from "vitest";
import {
	ApplicationResourceMetricsService,
	type AggregateMetricsSnapshot,
	type ResourceMetricsPort,
	type RuntimeRightsizing,
} from "$lib/server/application/resource-metrics";

describe("ApplicationResourceMetricsService", () => {
	it("delegates aggregate metrics, rightsizing, and sampling through the port", async () => {
		const port = fakePort();
		const service = new ApplicationResourceMetricsService(port);

		await expect(service.getAggregateMetrics()).resolves.toEqual(snapshot());
		await expect(
			service.computeRightsizingRecommendations({ windowDays: 7 }),
		).resolves.toEqual([rightsizing()]);
		await expect(service.sampleAndPersistSessionResourceUsage()).resolves.toEqual({
			pods: 2,
			matched: 1,
		});

		expect(port.getAggregateMetrics).toHaveBeenCalledTimes(1);
		expect(port.computeRightsizingRecommendations).toHaveBeenCalledWith(7);
		expect(port.sampleAndPersistSessionResourceUsage).toHaveBeenCalledTimes(1);
	});
});

function fakePort(): ResourceMetricsPort {
	return {
		getAggregateMetrics: vi.fn(async () => snapshot()),
		computeRightsizingRecommendations: vi.fn(async () => [rightsizing()]),
		sampleAndPersistSessionResourceUsage: vi.fn(async () => ({
			pods: 2,
			matched: 1,
		})),
	};
}

function snapshot(): AggregateMetricsSnapshot {
	return {
		resources: null,
		ts: "2026-01-01T00:00:00.000Z",
		workflows: {
			running: 1,
			success: 2,
			error: 0,
			cancelled: 0,
			pending: 0,
			failuresLast5Min: 0,
		},
		sessions: {
			running: 1,
			idle: 0,
			rescheduling: 0,
			terminated: 0,
			uniqueActiveAgents: 1,
		},
		tokens: {
			lastHour: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
			lastMinute: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
			ratePerSec: 0,
		},
		toolCallsLastHour: 0,
	};
}

function rightsizing(): RuntimeRightsizing {
	return {
		runtime: "dapr-agent-py",
		sampledSessions: 3,
		avgPeakCpuMillicores: 100,
		p90PeakCpuMillicores: 150,
		maxPeakCpuMillicores: 200,
		avgPeakMemoryMiB: 256,
		p90PeakMemoryMiB: 512,
		maxPeakMemoryMiB: 768,
		recommendedCpuRequestMillicores: 200,
		recommendedMemoryRequestMiB: 640,
	};
}
