import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateBenchmarkRuntimeCapacity } from "./runtime-capacity";

describe("estimateBenchmarkRuntimeCapacity", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("caps shared coding pools by replicas, slots, and global max", () => {
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
			slotsPerReplica: 5,
			maxActiveSessions: 10,
		});
		expect(capacity.capReason).toContain("runtime_capacity");
		expect(capacity.capReason).toContain("global_max");
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
			maxActiveSessions: 6,
			capReason: "runtime_capacity",
		});
	});
});
