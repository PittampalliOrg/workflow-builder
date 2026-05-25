import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateBenchmarkRuntimeCapacity } from "./runtime-capacity";

describe("estimateBenchmarkRuntimeCapacity", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("caps shared coding pools by replicas and slots", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 2,
			requestedInstanceCount: 25,
			requestedConcurrency: 25,
		});

		expect(capacity).toMatchObject({
			requestedConcurrency: 25,
			effectiveConcurrency: 10,
			runtimeClass: "coding",
			runtimeAppId: "agent-runtime-pool-coding",
			runtimeReplicas: 2,
			perSidecarWorkflowLimit: 5,
			daprWorkflowLimitPerSidecar: 5,
			daprWorkflowEffectiveCapacity: 10,
			runtimeSlots: 10,
			slotsPerReplica: 5,
			maxActiveSessions: 10,
			maxActiveSandboxes: null,
		});
		expect(capacity.capReason).toContain("runtime_capacity");
		expect(capacity.capReason).toContain("dapr_workflow_capacity");
		expect(capacity.capReason).not.toContain("global_max");
	});

	it("caps to selected instance count before dispatch", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 2,
			requestedInstanceCount: 3,
			requestedConcurrency: 10,
		});

		expect(capacity.effectiveConcurrency).toBe(3);
		expect(capacity.capReason).toBe("selected_instance_count");
	});

	it("honors runtime slot and global cap env overrides", () => {
		vi.stubEnv("AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON", JSON.stringify({ coding: 4, office: 3 }));
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "12");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "office",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-office",
			poolMaxReplicas: 5,
			requestedInstanceCount: 50,
			requestedConcurrency: 50,
		});

		expect(capacity).toMatchObject({
			capacityMode: "manual",
			effectiveConcurrency: 12,
			runtimeReplicas: 5,
			perSidecarWorkflowLimit: 3,
			daprWorkflowEffectiveCapacity: 15,
			runtimeSlots: 15,
			slotsPerReplica: 3,
			configuredMaxActiveInferenceInstances: 12,
			maxActiveInferenceInstances: 12,
			maxActiveSessions: 12,
			capReason: "global_max",
		});
	});

	it("can derive global inference capacity in auto mode", () => {
		vi.stubEnv("BENCHMARK_CAPACITY_MODE", "auto");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 10,
			slotsPerReplica: 8,
			requestedInstanceCount: 100,
			requestedConcurrency: 100,
			sandboxCapacity: {
				schedulableSandboxCapacity: 80,
				totalSchedulableSandboxCapacity: 96,
			} as never,
		});

		expect(capacity).toMatchObject({
			capacityMode: "auto",
			effectiveConcurrency: 80,
			runtimeSlots: 80,
			configuredMaxActiveInferenceInstances: null,
			maxActiveInferenceInstances: 80,
			maxActiveSandboxes: 96,
			capReason: "runtime_capacity+dapr_workflow_capacity+sandbox_schedulable_capacity",
		});
	});

	it("lets Kueue-backed runs bypass shared runtime slots while respecting sandbox headroom", () => {
		vi.stubEnv("BENCHMARK_CAPACITY_MODE", "auto");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "96");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_SANDBOXES", "96");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			slotsPerReplica: 8,
			requestedInstanceCount: 120,
			requestedConcurrency: 120,
			executionBackend: "dapr-kueue",
			sandboxCapacity: {
				schedulableSandboxCapacity: 80,
				totalSchedulableSandboxCapacity: 96,
			} as never,
		});

		expect(capacity).toMatchObject({
			capacityMode: "kueue",
			effectiveConcurrency: 80,
			runtimeSlots: 32,
			configuredMaxActiveInferenceInstances: 96,
			maxActiveInferenceInstances: null,
			configuredMaxActiveSandboxes: 96,
			maxActiveSandboxes: 96,
			capReason: "sandbox_schedulable_capacity",
		});
	});

	it("caps Kueue-backed runs by full instance capacity when agent hosts also use the queue", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 14,
			slotsPerReplica: 12,
			requestedInstanceCount: 200,
			requestedConcurrency: 200,
			executionBackend: "dapr-kueue",
			sandboxCapacity: {
				schedulableSandboxCapacity: 336,
				schedulableKueueInstanceCapacity: 128,
				totalSchedulableSandboxCapacity: 336,
			} as never,
		});

		expect(capacity).toMatchObject({
			capacityMode: "kueue",
			effectiveConcurrency: 128,
			runtimeSlots: 168,
			schedulableSandboxCapacity: 336,
			capReason: "kueue_capacity",
		});
	});

	it("lets Kueue-backed runs use full selected fan-out when sandbox headroom is unknown", () => {
		vi.stubEnv("BENCHMARK_CAPACITY_MODE", "auto");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "96");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			slotsPerReplica: 8,
			requestedInstanceCount: 120,
			requestedConcurrency: 120,
			executionBackend: "dapr-kueue",
		});

		expect(capacity).toMatchObject({
			capacityMode: "kueue",
			effectiveConcurrency: 120,
			runtimeSlots: 32,
			configuredMaxActiveInferenceInstances: 96,
			maxActiveInferenceInstances: null,
			maxActiveSessions: 120,
			capReason: null,
		});
	});

	it("keeps explicit provider caps for Kueue-backed runs", () => {
		vi.stubEnv("BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS", "48");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			slotsPerReplica: 8,
			requestedInstanceCount: 120,
			requestedConcurrency: 120,
			executionBackend: "dapr-kueue",
		});

		expect(capacity).toMatchObject({
			capacityMode: "kueue",
			effectiveConcurrency: 48,
			deterministicConcurrency: 48,
			pressureAdjustedConcurrency: 48,
			modelMaxActiveRequests: 48,
			capReason: "model_capacity",
		});
	});

	it("honors per-model provider caps before falling back to global caps", () => {
		vi.stubEnv(
			"BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS_JSON",
			JSON.stringify({
				"anthropic/claude-opus-4-7": 8,
				"deepseek/deepseek-v4-pro": 24,
			}),
		);
		vi.stubEnv("BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS", "64");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			slotsPerReplica: 8,
			requestedInstanceCount: 120,
			requestedConcurrency: 120,
			modelNameOrPath: "deepseek/deepseek-v4-pro",
			executionBackend: "dapr-kueue",
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 24,
			modelMaxActiveRequests: 24,
			capReason: "model_capacity",
		});
	});

	it("reduces Kueue-backed fan-out under non-blocking cluster pressure", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 8,
			slotsPerReplica: 12,
			requestedInstanceCount: 100,
			requestedConcurrency: 80,
			executionBackend: "dapr-kueue",
			clusterPressure: {
				pressure: true,
				hardBlock: false,
				reductionFactor: 0.5,
				reasons: ["psi_memory_pressure"],
			} as never,
		});

		expect(capacity).toMatchObject({
			capacityMode: "kueue",
			deterministicConcurrency: 80,
			pressureAdjustedConcurrency: 40,
			effectiveConcurrency: 40,
			capReason: "psi_memory_pressure",
		});
	});

	it("blocks new starts under hard cluster pressure", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 8,
			slotsPerReplica: 12,
			requestedInstanceCount: 100,
			requestedConcurrency: 80,
			executionBackend: "dapr-kueue",
			clusterPressure: {
				pressure: true,
				hardBlock: true,
				reductionFactor: 1,
				reasons: ["psi_io_pressure"],
			} as never,
		});

		expect(capacity).toMatchObject({
			deterministicConcurrency: 80,
			pressureAdjustedConcurrency: 0,
			effectiveConcurrency: 0,
			capReason: "psi_io_pressure",
		});
	});

	it("blocks new Kueue-backed starts under agent-host Dapr pressure", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 8,
			slotsPerReplica: 12,
			requestedInstanceCount: 100,
			requestedConcurrency: 80,
			executionBackend: "dapr-kueue",
			agentHostRuntime: {
				namespace: "workflow-builder",
				activePods: 12,
				unhealthyPods: ["agent-host-agent-session-oom"],
				appContainerOomKilledPods: ["agent-host-agent-session-oom"],
				recentActorErrorCount: 1,
				recentReminderErrorCount: 0,
				logWindowSeconds: 300,
				daprRuntimePressure: true,
				pressureReasons: ["agent_host_oom_killed", "agent_host_actor_errors"],
				error: null,
			},
		});

		expect(capacity).toMatchObject({
			deterministicConcurrency: 80,
			pressureAdjustedConcurrency: 0,
			effectiveConcurrency: 0,
			agentHostActivePods: 12,
			agentHostDaprRuntimePressure: true,
			capReason: "agent_host_pressure",
			primaryLimiter: "agent_host_pressure",
		});
		expect(capacity.agentHostOomKilledPods).toEqual(["agent-host-agent-session-oom"]);
	});

	it("blocks new starts under parent workflow start-timeout pressure", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 8,
			slotsPerReplica: 12,
			requestedInstanceCount: 100,
			requestedConcurrency: 80,
			executionBackend: "dapr-kueue",
			parentWorkflowRuntime: {
				parentAppId: "workflow-orchestrator",
				namespace: "workflow-builder",
				configName: "workflow-builder-tracing",
				replicas: 1,
				readyReplicas: 1,
				availableReplicas: 1,
				connectedWorkflowWorkers: 1,
				connectedWorkerPods: 1,
				podWorkers: [],
				workflowLimitPerSidecar: 128,
				activityLimitPerSidecar: 512,
				effectiveWorkflowCapacity: 128,
				effectiveActivityCapacity: 512,
				daprRuntimeVersion: "1.17.7",
				schedulerPods: 3,
				schedulerReadyPods: 3,
				recentActorErrorCount: 0,
				recentReminderErrorCount: 0,
				recentStartPendingTimeoutCount: 3,
				logWindowSeconds: 300,
				daprRuntimePressure: true,
				error: null,
			},
		});

		expect(capacity).toMatchObject({
			deterministicConcurrency: 80,
			pressureAdjustedConcurrency: 0,
			effectiveConcurrency: 0,
			daprRecentStartPendingTimeoutCount: 3,
			capReason: "dapr_runtime_pressure",
			primaryLimiter: "dapr_runtime_pressure",
		});
	});

	it("keeps a configured global inference cap as the auto-mode hard ceiling", () => {
		vi.stubEnv("BENCHMARK_CAPACITY_MODE", "auto");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "72");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 10,
			slotsPerReplica: 8,
			requestedInstanceCount: 100,
			requestedConcurrency: 100,
			sandboxCapacity: {
				schedulableSandboxCapacity: 96,
				totalSchedulableSandboxCapacity: 96,
			} as never,
		});

		expect(capacity).toMatchObject({
			capacityMode: "auto",
			effectiveConcurrency: 72,
			configuredMaxActiveInferenceInstances: 72,
			maxActiveInferenceInstances: 72,
			capReason: "global_max",
		});
	});

	it("honors explicit pool maxActiveSessions as a runtime cap", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 2,
			slotsPerReplica: 5,
			maxActiveSessions: 6,
			requestedInstanceCount: 10,
			requestedConcurrency: 10,
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 6,
			perSidecarWorkflowLimit: 5,
			runtimeSlots: 10,
			maxActiveSessions: 6,
			capReason: "runtime_capacity",
		});
	});

	it("honors an optional sandbox admission cap", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "20");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_SANDBOXES", "8");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 3,
			requestedInstanceCount: 15,
			requestedConcurrency: 15,
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 8,
			perSidecarWorkflowLimit: 5,
			runtimeSlots: 15,
			maxActiveSessions: 15,
			configuredMaxActiveSandboxes: 8,
			maxActiveSandboxes: 8,
			capReason: "sandbox_capacity",
		});
	});

	it("caps run concurrency by schedulable sandbox headroom", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "20");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			requestedInstanceCount: 20,
			requestedConcurrency: 20,
			sandboxCapacity: {
				schedulableSandboxCapacity: 6,
				totalSchedulableSandboxCapacity: 40,
			} as never,
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 6,
			runtimeSlots: 20,
			schedulableSandboxCapacity: 6,
			maxActiveSandboxes: 40,
			capReason: "sandbox_schedulable_capacity",
		});
	});

	it("allows zero effective concurrency when no sandbox headroom remains", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "20");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			requestedInstanceCount: 20,
			requestedConcurrency: 10,
			sandboxCapacity: {
				schedulableSandboxCapacity: 0,
				totalSchedulableSandboxCapacity: 40,
			} as never,
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 0,
			maxActiveSandboxes: 40,
			schedulableSandboxCapacity: 0,
			capReason: "sandbox_schedulable_capacity",
		});
	});

	it("keeps configured sandbox caps as a hard safety cap", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "50");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_SANDBOXES", "8");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			requestedInstanceCount: 20,
			requestedConcurrency: 20,
			schedulableSandboxCapacity: 12,
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 8,
			configuredMaxActiveSandboxes: 8,
			maxActiveSandboxes: 8,
			schedulableSandboxCapacity: 12,
			capReason: "sandbox_capacity",
		});
	});

	it("accounts for a model request cap independently", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "50");
		vi.stubEnv("BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS", "7");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			requestedInstanceCount: 20,
			requestedConcurrency: 20,
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 7,
			modelMaxActiveRequests: 7,
			capReason: "model_capacity",
		});
	});

	it("multiplies per-sidecar Dapr workflow limits by pool replicas", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "50");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			slotsPerReplica: 3,
			requestedInstanceCount: 20,
			requestedConcurrency: 20,
		});

		expect(capacity).toMatchObject({
			runtimeReplicas: 4,
			perSidecarWorkflowLimit: 3,
			effectiveConcurrency: 12,
			maxActiveSessions: 12,
		});
		expect(capacity.capReason).toContain("runtime_capacity");
		expect(capacity.capReason).toContain("dapr_workflow_capacity");
	});

	it("accounts for Dapr workflow capacity independently from app slots", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "50");
		vi.stubEnv("AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR", "2");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 4,
			slotsPerReplica: 5,
			requestedInstanceCount: 20,
			requestedConcurrency: 20,
		});

		expect(capacity).toMatchObject({
			runtimeSlots: 20,
			daprWorkflowLimitPerSidecar: 2,
			daprWorkflowEffectiveCapacity: 8,
			effectiveConcurrency: 8,
		});
		expect(capacity.capReason).toContain("dapr_workflow_capacity");
	});

	it("accounts for parent workflow capacity independently from child runtime capacity", () => {
		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 8,
			slotsPerReplica: 12,
			requestedInstanceCount: 50,
			requestedConcurrency: 50,
			parentWorkflowRuntime: {
				parentAppId: "workflow-orchestrator",
				namespace: "workflow-builder",
				configName: "workflow-builder-tracing",
				replicas: 2,
				readyReplicas: 2,
				availableReplicas: 2,
				connectedWorkflowWorkers: 2,
				connectedWorkerPods: 2,
				podWorkers: [],
				workflowLimitPerSidecar: 16,
				activityLimitPerSidecar: 64,
				effectiveWorkflowCapacity: 32,
				effectiveActivityCapacity: 128,
				daprRuntimeVersion: "1.17.7",
				schedulerPods: 3,
				schedulerReadyPods: 3,
				recentActorErrorCount: 0,
				recentReminderErrorCount: 0,
				recentStartPendingTimeoutCount: 0,
				logWindowSeconds: 1800,
				daprRuntimePressure: false,
				error: null,
			},
		});

		expect(capacity).toMatchObject({
			effectiveConcurrency: 32,
			parentWorkflowReplicas: 2,
			parentWorkflowConnectedWorkers: 2,
			parentWorkflowLimitPerSidecar: 16,
			parentWorkflowEffectiveCapacity: 32,
			parentActivityEffectiveCapacity: 128,
			daprRuntimeVersion: "1.17.7",
			daprSchedulerPods: 3,
			daprRecentStartPendingTimeoutCount: 0,
			capReason: "dapr_parent_capacity",
			primaryLimiter: "dapr_parent_capacity",
		});
		expect(capacity.capacityLimiters).toContain("dapr_parent_capacity");
	});

	it("honors an active agent workflow cap independently from scheduler capacity", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "50");
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS", "18");

		const capacity = estimateBenchmarkRuntimeCapacity({
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			runtimeAppId: "agent-runtime-pool-coding",
			poolMaxReplicas: 6,
			slotsPerReplica: 5,
			requestedInstanceCount: 30,
			requestedConcurrency: 30,
			schedulableSandboxCapacity: 30,
		});

		expect(capacity).toMatchObject({
			runtimeSlots: 30,
			daprWorkflowEffectiveCapacity: 30,
			agentWorkflowMaxActiveTurns: 18,
			effectiveConcurrency: 18,
		});
		expect(capacity.capReason).toBe("agent_workflow_capacity");
	});
});
