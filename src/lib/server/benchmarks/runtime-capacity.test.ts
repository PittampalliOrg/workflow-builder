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
		vi.stubEnv(
			"AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON",
			JSON.stringify({ coding: 4, office: 3 }),
		);
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
			effectiveConcurrency: 12,
			runtimeReplicas: 5,
			perSidecarWorkflowLimit: 3,
			daprWorkflowEffectiveCapacity: 15,
			runtimeSlots: 15,
			slotsPerReplica: 3,
			maxActiveSessions: 12,
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
