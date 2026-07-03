export type PodClass =
	| "agent-runtime"
	| "sandbox"
	| "workspace-runtime"
	| "workflow-orchestrator"
	| "workflow-builder"
	| "swebench"
	| "other";

export type PodResourceUsage = {
	name: string;
	cpuMillicores: number;
	memoryMiB: number;
	class: PodClass;
	labels: Record<string, string>;
};

export type ResourceUsageSummary = {
	totalCpuMillicores: number;
	totalMemoryMiB: number;
	byClass: Record<
		PodClass,
		{ count: number; cpuMillicores: number; memoryMiB: number }
	>;
	pods: PodResourceUsage[];
};

export type TokenWindow = {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	total: number;
};

export type AggregateMetricsSnapshot = {
	resources: ResourceUsageSummary | null;
	ts: string;
	workflows: {
		running: number;
		success: number;
		error: number;
		cancelled: number;
		pending: number;
		failuresLast5Min: number;
	};
	sessions: {
		running: number;
		idle: number;
		rescheduling: number;
		terminated: number;
		uniqueActiveAgents: number;
	};
	tokens: {
		lastHour: TokenWindow;
		lastMinute: TokenWindow;
		ratePerSec: number;
	};
	toolCallsLastHour: number;
};

export type RuntimeRightsizing = {
	runtime: string;
	sampledSessions: number;
	avgPeakCpuMillicores: number;
	p90PeakCpuMillicores: number;
	maxPeakCpuMillicores: number;
	avgPeakMemoryMiB: number;
	p90PeakMemoryMiB: number;
	maxPeakMemoryMiB: number;
	recommendedCpuRequestMillicores: number;
	recommendedMemoryRequestMiB: number;
};

export type SessionResourceSampleResult = {
	pods: number;
	matched: number;
};

export interface ResourceMetricsPort {
	getAggregateMetrics(): Promise<AggregateMetricsSnapshot>;
	computeRightsizingRecommendations(windowDays?: number): Promise<RuntimeRightsizing[]>;
	sampleAndPersistSessionResourceUsage(): Promise<SessionResourceSampleResult>;
}

export class ApplicationResourceMetricsService {
	constructor(private readonly metrics: ResourceMetricsPort) {}

	getAggregateMetrics() {
		return this.metrics.getAggregateMetrics();
	}

	computeRightsizingRecommendations(input: { windowDays?: number }) {
		return this.metrics.computeRightsizingRecommendations(input.windowDays);
	}

	sampleAndPersistSessionResourceUsage() {
		return this.metrics.sampleAndPersistSessionResourceUsage();
	}
}
